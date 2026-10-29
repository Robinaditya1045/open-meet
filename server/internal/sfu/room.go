package sfu

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// ErrRoomClosed reports signaling for a room that has been shut down.
var ErrRoomClosed = errors.New("sfu: room is closed")

// speakerInterval is how often audio levels are folded into a speaker report.
const speakerInterval = 200 * time.Millisecond

// Signaler delivers what the SFU produces to the participants it belongs to. It
// must not block, and must not call back into the room.
type Signaler interface {
	SendDescription(peerID string, sd webrtc.SessionDescription)
	SendCandidate(peerID string, c webrtc.ICECandidateInit)
	SendAudioLevels(levels map[string]float64, dominant string)
}

// Room routes media between the peers of one meeting.
type Room struct {
	id       string
	engine   *Engine
	signaler Signaler
	speakers *speakerDetector

	mu    sync.RWMutex
	peers map[string]*Peer
	pubs  map[string]*Publication
	// prefs holds what each participant last asked to receive, so preferences
	// that arrive before (or outlive) its connection apply to the next one.
	prefs  map[string]map[string]Quality
	closed bool
	done   chan struct{}
}

// NewRoom creates a room that reports through signaler.
func (e *Engine) NewRoom(id string, signaler Signaler) *Room {
	r := &Room{
		id:       id,
		engine:   e,
		signaler: signaler,
		speakers: newSpeakerDetector(),
		peers:    map[string]*Peer{},
		pubs:     map[string]*Publication{},
		prefs:    map[string]map[string]Quality{},
		done:     make(chan struct{}),
	}
	go r.reportSpeakers()
	return r
}

// HandleOffer applies an offer from a participant's browser, creating its
// connection if it has none. restart discards an existing connection first: the
// browser built a new RTCPeerConnection (a reload, or recovery from a failed one)
// and the old one can never be resumed.
func (r *Room) HandleOffer(peerID, sdp string, streams map[string]string, restart bool) error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return ErrRoomClosed
	}
	peer := r.peers[peerID]
	var stale *Peer
	if peer != nil && (restart || !peer.usable()) {
		stale, peer = peer, nil
		delete(r.peers, peerID)
	}
	created := false
	if peer == nil {
		var err error
		peer, err = r.newPeer(peerID)
		if err != nil {
			r.mu.Unlock()
			if stale != nil {
				r.dropPeer(stale)
			}
			return err
		}
		r.peers[peerID] = peer
		created = true
	}
	r.mu.Unlock()

	if stale != nil {
		r.dropPeer(stale)
	}
	if streams != nil {
		peer.declareStreams(streams)
	}
	if err := peer.handleOffer(sdp); err != nil {
		if created {
			r.removePeerIf(peer)
		}
		return err
	}
	if created {
		// Everything already being published reaches the newcomer on the SFU's
		// first offer, which follows the answer that just went out.
		for _, pub := range r.publicationsExcept(peerID) {
			r.subscribe(peer, pub)
		}
	}
	peer.Negotiate()
	return nil
}

// HandleAnswer applies a participant's answer to an SFU offer.
func (r *Room) HandleAnswer(peerID, sdp string, streams map[string]string) error {
	peer := r.peer(peerID)
	if peer == nil {
		return nil
	}
	if streams != nil {
		peer.declareStreams(streams)
	}
	return peer.handleAnswer(sdp)
}

// AddCandidate applies an ICE candidate a participant's browser trickled.
func (r *Room) AddCandidate(peerID string, c webrtc.ICECandidateInit) error {
	peer := r.peer(peerID)
	if peer == nil {
		return nil
	}
	return peer.addICECandidate(c)
}

// SetPreferences replaces what a participant wants of each video it receives,
// keyed by track name. Anything not listed gets the default for its kind.
func (r *Room) SetPreferences(peerID string, prefs map[string]Quality) {
	r.mu.Lock()
	r.prefs[peerID] = prefs
	peer := r.peers[peerID]
	r.mu.Unlock()
	if peer != nil {
		peer.setPreferences(prefs)
	}
}

// Resync picks signaling back up after a participant's signaling connection
// came back. An SFU offer sent while it was down never arrived; until it is
// answered every offer from the browser collides with it, so it goes out again.
func (r *Room) Resync(peerID string) {
	if peer := r.peer(peerID); peer != nil {
		peer.resync()
	}
}

// RemovePeer disconnects a participant's media.
func (r *Room) RemovePeer(peerID string) {
	r.mu.Lock()
	peer := r.peers[peerID]
	delete(r.peers, peerID)
	delete(r.prefs, peerID)
	r.mu.Unlock()
	if peer != nil {
		r.dropPeer(peer)
	}
}

// PeerCount reports how many participants have a media connection.
func (r *Room) PeerCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.peers)
}

// Close disconnects everyone.
func (r *Room) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	close(r.done)
	peers := make([]*Peer, 0, len(r.peers))
	for _, p := range r.peers {
		peers = append(peers, p)
	}
	pubs := make([]*Publication, 0, len(r.pubs))
	for _, pub := range r.pubs {
		pubs = append(pubs, pub)
	}
	r.peers = map[string]*Peer{}
	r.pubs = map[string]*Publication{}
	r.mu.Unlock()

	for _, pub := range pubs {
		pub.close()
	}
	for _, p := range peers {
		p.close()
	}
}

func (r *Room) peer(id string) *Peer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.peers[id]
}

// newPeer creates a participant's connection. Called with r.mu held.
func (r *Room) newPeer(id string) (*Peer, error) {
	pc, err := r.engine.newPeerConnection()
	if err != nil {
		return nil, fmt.Errorf("create peer connection: %w", err)
	}
	prefs := r.prefs[id]
	if prefs == nil {
		prefs = map[string]Quality{}
	}
	p := &Peer{
		id:    id,
		room:  r,
		pc:    pc,
		subs:  map[string]*subscription{},
		prefs: prefs,
	}

	// The browser can only reach the SFU through candidates it is told about, and
	// the answer goes out before gathering finishes, so trickling is the only
	// delivery path for most of them.
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			r.signaler.SendCandidate(id, c.ToJSON())
		}
	})
	pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		r.onTrack(p, remote, receiver)
	})
	// A browser that crashes, sleeps or loses its network never says goodbye; the
	// connection state is the only sign. Left alone, the room would keep
	// forwarding to it and everyone would keep a frozen tile.
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		slog.Debug("sfu peer connection state", "room", r.id, "peer", id, "state", state.String())
		if state == webrtc.PeerConnectionStateFailed {
			r.removePeerIf(p)
		}
	})
	return p, nil
}

// removePeerIf removes p only if it is still the participant's current
// connection, so a late callback from a replaced connection cannot take down
// the one that replaced it.
func (r *Room) removePeerIf(p *Peer) {
	r.mu.Lock()
	current := r.peers[p.id] == p
	if current {
		delete(r.peers, p.id)
	}
	r.mu.Unlock()
	r.dropPeer(p)
}

// dropPeer retires everything a peer published, detaches it from everything it
// received, and closes it. The peer must already be out of r.peers.
func (r *Room) dropPeer(p *Peer) {
	r.mu.Lock()
	var owned []*Publication
	for name, pub := range r.pubs {
		if pub.owner == p {
			owned = append(owned, pub)
			delete(r.pubs, name)
		}
	}
	r.mu.Unlock()

	for _, pub := range owned {
		r.unpublish(pub)
	}
	for _, pub := range p.subscriptions() {
		pub.removeDown(p.id)
	}
	p.close()
	r.speakers.remove(p.id)
}

// onTrack handles one incoming encoding: the first layer of a publication creates
// it, further simulcast layers of the same transceiver join it.
func (r *Room) onTrack(p *Peer, remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	kind := p.publishedKind(remote.StreamID(), remote.Kind())
	index := ridLayer(remote.RID())
	if index < 0 {
		slog.Warn("sfu: ignoring unknown simulcast rid", "peer", p.id, "rid", remote.RID())
		return
	}
	name := TrackName(kind, p.id)

	r.mu.Lock()
	if r.closed || r.peers[p.id] != p {
		r.mu.Unlock()
		return
	}
	pub := r.pubs[name]
	var stale *Publication
	if pub != nil && pub.receiver != receiver {
		// The same kind on a different transceiver: the browser replaced it.
		stale, pub = pub, nil
		delete(r.pubs, name)
	}
	created := false
	if pub == nil {
		pub = newPublication(r, p, name, kind, remote.Codec().RTPCodecCapability, receiver)
		r.pubs[name] = pub
		created = true
	}
	r.mu.Unlock()

	if stale != nil {
		r.unpublish(stale)
	}
	pub.addLayer(index, remote)
	slog.Info("sfu track published", "room", r.id, "track", name, "rid", remote.RID(), "codec", remote.Codec().MimeType)

	if created {
		// Attaching a track to an established connection does nothing until the
		// browser is offered it; this renegotiation is what makes a newcomer
		// visible to everyone already in the call.
		for _, sub := range r.peersExcept(p.id) {
			r.subscribe(sub, pub)
			sub.Negotiate()
		}
	}
}

func (r *Room) subscribe(sub *Peer, pub *Publication) {
	down, err := sub.subscribe(pub)
	if err != nil {
		if !errors.Is(err, ErrPeerClosed) {
			slog.Error("sfu: subscribe", "subscriber", sub.id, "track", pub.name, "error", err)
		}
		return
	}
	if down == nil {
		return
	}
	if !pub.addDown(down) {
		sub.unsubscribe(pub)
		return
	}
	down.reevaluate()
}

// retirePublication removes a publication whose source has gone away, unless it
// was already retired or replaced.
func (r *Room) retirePublication(pub *Publication) {
	r.mu.Lock()
	current := r.pubs[pub.name] == pub
	if current {
		delete(r.pubs, pub.name)
	}
	r.mu.Unlock()
	if current {
		r.unpublish(pub)
	}
}

// unpublish stops a publication and takes it away from every subscriber.
func (r *Room) unpublish(pub *Publication) {
	if !pub.close() {
		return
	}
	for _, sub := range r.peersExcept(pub.owner.id) {
		sub.unsubscribe(pub)
		sub.Negotiate()
	}
	slog.Info("sfu track unpublished", "room", r.id, "track", pub.name)
}

func (r *Room) peersExcept(id string) []*Peer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	peers := make([]*Peer, 0, len(r.peers))
	for pid, p := range r.peers {
		if pid != id {
			peers = append(peers, p)
		}
	}
	return peers
}

func (r *Room) publicationsExcept(ownerID string) []*Publication {
	r.mu.RLock()
	defer r.mu.RUnlock()
	pubs := make([]*Publication, 0, len(r.pubs))
	for _, pub := range r.pubs {
		if pub.owner.id != ownerID {
			pubs = append(pubs, pub)
		}
	}
	return pubs
}

func (r *Room) reportSpeakers() {
	ticker := time.NewTicker(speakerInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.done:
			return
		case <-ticker.C:
			if levels, dominant, changed := r.speakers.tick(); changed {
				r.signaler.SendAudioLevels(levels, dominant)
			}
		}
	}
}
