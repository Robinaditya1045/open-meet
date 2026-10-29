package sfu

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

var (
	// ErrOfferCollision reports a browser offer that arrived while the SFU was still
	// waiting for the answer to an offer of its own. The SFU keeps the wheel: the
	// browser is the polite peer, rolls its offer back, answers the SFU's, and
	// offers again once that exchange settles.
	ErrOfferCollision = errors.New("sfu: offer collided with a renegotiation in flight")

	// ErrPeerClosed reports signaling that arrived after the connection went away.
	ErrPeerClosed = errors.New("sfu: peer connection is closed")
)

// subscription is one publication being sent to this peer, on a transceiver of
// its own.
type subscription struct {
	pub         *Publication
	down        *DownTrack
	sender      *webrtc.RTPSender
	transceiver *webrtc.RTPTransceiver
}

// Peer is one participant's WebRTC connection. It publishes the participant's own
// media and receives everyone else's.
//
// Every publication a peer subscribes to gets its own sendonly transceiver created
// by the SFU, never one of the browser's publishing m-lines. That keeps the two
// directions apart (a camera m-line is a simulcast send for the browser and stays
// one) and means a forwarded track always arrives as a fresh browser track whose
// msid names its owner. Transceivers freed by someone leaving are recycled once
// the browser has acknowledged them as inactive, so the SDP stays the size of the
// call rather than growing with everyone who ever passed through it.
type Peer struct {
	id   string
	room *Room
	pc   *webrtc.PeerConnection

	mu sync.Mutex
	// established gates SFU-initiated offers until the browser's first offer has
	// been answered; offering earlier would race it for nothing.
	established bool
	// dirty marks a subscription change the browser has not been offered yet.
	dirty bool
	// queued marks a renegotiation deferred because an exchange was in flight.
	queued bool
	closed bool

	// streamKinds is what the browser says each stream it publishes is, keyed by
	// MediaStream ID. A camera and a screen share are both just video otherwise.
	streamKinds map[string]string

	subs  map[string]*subscription
	prefs map[string]Quality

	// Transceivers on their way to being reusable: retiring were detached since
	// the last description the SFU produced, inFlight are inactive in an offer
	// awaiting its answer, and free were confirmed inactive by a completed exchange.
	retiring []*webrtc.RTPTransceiver
	inFlight []*webrtc.RTPTransceiver
	free     []*webrtc.RTPTransceiver
}

// ID is the participant this connection belongs to.
func (p *Peer) ID() string { return p.id }

// declareStreams records what each published stream is. The browser sends the
// full set with every description, so this replaces rather than merges, and it
// must land before the description it came with is applied, because applying it
// is what lets the browser's media start arriving.
func (p *Peer) declareStreams(kinds map[string]string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.streamKinds = kinds
}

// publishedKind classifies a track this peer published. Audio is always the
// microphone; video is whatever its stream was declared as, defaulting to camera.
func (p *Peer) publishedKind(streamID string, codecType webrtc.RTPCodecType) string {
	if codecType == webrtc.RTPCodecTypeAudio {
		return KindMic
	}
	p.mu.Lock()
	declared := p.streamKinds[streamID]
	p.mu.Unlock()
	if declared == KindScreen {
		return KindScreen
	}
	return KindCamera
}

// handleOffer applies a browser offer and sends the answer.
//
// The answer goes out from under the peer's lock on purpose. Once the answer is
// applied the connection is stable, and another goroutine could then produce an
// SFU offer; were that offer to reach the browser before this answer, the browser
// would see an offer while waiting for an answer and roll its own offer back.
func (p *Peer) handleOffer(sdp string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		return ErrPeerClosed
	}
	if p.pc.SignalingState() != webrtc.SignalingStateStable {
		return ErrOfferCollision
	}
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return fmt.Errorf("apply offer: %w", err)
	}
	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return fmt.Errorf("create answer: %w", err)
	}
	if err := p.pc.SetLocalDescription(answer); err != nil {
		return fmt.Errorf("apply answer: %w", err)
	}
	// SetLocalDescription starts ICE gathering; the description read back after
	// it carries the credentials and whatever candidates are already known.
	if local := p.pc.LocalDescription(); local != nil {
		answer = *local
	}

	p.established = true
	// The answer settles everything detached before it.
	p.free = append(p.free, p.retiring...)
	p.retiring = nil
	// An answer can only cover the m-lines the browser offered. Subscriptions on
	// transceivers the browser has never seen still need an offer of their own.
	p.dirty = p.hasUnnegotiatedSenders()

	p.room.signaler.SendDescription(p.id, answer)
	return nil
}

// hasUnnegotiatedSenders reports whether any attached track sits on a transceiver
// the browser has not been told about. A transceiver gets its mid by being negotiated.
func (p *Peer) hasUnnegotiatedSenders() bool {
	for _, t := range p.pc.GetTransceivers() {
		if t.Mid() != "" {
			continue
		}
		if s := t.Sender(); s != nil && s.Track() != nil {
			return true
		}
	}
	return false
}

// handleAnswer applies the browser's answer to an SFU offer, then runs any
// renegotiation deferred while the exchange was open.
func (p *Peer) handleAnswer(sdp string) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return ErrPeerClosed
	}
	if p.pc.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
		// An answer to an offer the exchange already moved past; applying it would
		// corrupt the current one.
		p.mu.Unlock()
		return nil
	}
	err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp})
	if err == nil {
		p.free = append(p.free, p.inFlight...)
		p.inFlight = nil
	}
	queued := p.queued
	p.queued = false
	p.mu.Unlock()

	if err != nil {
		return fmt.Errorf("apply answer: %w", err)
	}
	if queued {
		p.Negotiate()
	}
	return nil
}

// Negotiate offers the current subscriptions to the browser if it has fallen
// behind. It is cheap to call after every change: it does nothing when the browser
// is up to date, and defers rather than drops when an exchange is already open.
func (p *Peer) Negotiate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || !p.established || !p.dirty {
		return
	}
	if p.pc.SignalingState() != webrtc.SignalingStateStable {
		p.queued = true
		return
	}

	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		slog.Error("sfu: create renegotiation offer", "peer", p.id, "error", err)
		return
	}
	if err := p.pc.SetLocalDescription(offer); err != nil {
		slog.Error("sfu: apply renegotiation offer", "peer", p.id, "error", err)
		return
	}
	if local := p.pc.LocalDescription(); local != nil {
		offer = *local
	}
	p.dirty = false
	p.inFlight = append(p.inFlight, p.retiring...)
	p.retiring = nil
	p.room.signaler.SendDescription(p.id, offer)
}

func (p *Peer) resync() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	if p.pc.SignalingState() == webrtc.SignalingStateHaveLocalOffer {
		if local := p.pc.LocalDescription(); local != nil {
			p.room.signaler.SendDescription(p.id, *local)
		}
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	p.Negotiate()
}

// addICECandidate applies a candidate the browser trickled.
func (p *Peer) addICECandidate(c webrtc.ICECandidateInit) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrPeerClosed
	}
	return p.pc.AddICECandidate(c)
}

// subscribe starts sending a publication to this peer. It does not negotiate; the
// caller does, once, after a batch of changes.
func (p *Peer) subscribe(pub *Publication) (*DownTrack, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, ErrPeerClosed
	}
	if existing, ok := p.subs[pub.name]; ok && existing.pub == pub {
		return nil, nil
	}

	track, err := webrtc.NewTrackLocalStaticRTP(pub.codec, pub.name, pub.name)
	if err != nil {
		return nil, fmt.Errorf("create forwarded track: %w", err)
	}
	sender, transceiver, err := p.attach(track)
	if err != nil {
		return nil, err
	}

	quality, ok := p.prefs[pub.name]
	if !ok {
		quality = defaultQuality(pub.kind)
	}
	down := newDownTrack(p.id, pub.name, pub.isVideo, pub.codec.ClockRate, track,
		pub.requestKeyframe, pub.layerState, quality)

	p.subs[pub.name] = &subscription{pub: pub, down: down, sender: sender, transceiver: transceiver}
	p.dirty = true
	go readSenderRTCP(sender, down)
	return down, nil
}

// attach puts a track on a recycled transceiver of the right kind, or a new one.
func (p *Peer) attach(track *webrtc.TrackLocalStaticRTP) (*webrtc.RTPSender, *webrtc.RTPTransceiver, error) {
	for i, t := range p.free {
		if t.Kind() != track.Kind() {
			continue
		}
		p.free = append(p.free[:i], p.free[i+1:]...)
		sender, err := p.room.engine.api.NewRTPSender(track, p.pc.SCTP().Transport())
		if err != nil {
			return nil, nil, fmt.Errorf("create sender: %w", err)
		}
		if err := t.SetSender(sender, track); err != nil {
			_ = sender.Stop()
			slog.Warn("sfu: could not recycle transceiver", "peer", p.id, "error", err)
			break
		}
		return sender, t, nil
	}

	t, err := p.pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendonly,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("add transceiver: %w", err)
	}
	return t.Sender(), t, nil
}

// unsubscribe stops sending a publication to this peer.
func (p *Peer) unsubscribe(pub *Publication) {
	p.mu.Lock()
	defer p.mu.Unlock()
	sub, ok := p.subs[pub.name]
	if !ok || sub.pub != pub {
		return
	}
	delete(p.subs, pub.name)
	sub.down.close()
	if p.closed {
		return
	}
	if err := p.pc.RemoveTrack(sub.sender); err != nil {
		slog.Warn("sfu: detach forwarded track", "peer", p.id, "track", pub.name, "error", err)
		return
	}
	p.retiring = append(p.retiring, sub.transceiver)
	p.dirty = true
}

// setPreferences replaces what this subscriber wants of each video publication.
func (p *Peer) setPreferences(prefs map[string]Quality) {
	p.mu.Lock()
	p.prefs = prefs
	downs := make(map[string]*subscription, len(p.subs))
	for name, sub := range p.subs {
		downs[name] = sub
	}
	p.mu.Unlock()

	for name, sub := range downs {
		q, ok := prefs[name]
		if !ok {
			q = defaultQuality(sub.pub.kind)
		}
		sub.down.SetQuality(q)
	}
}

// defaultQuality is what a subscriber gets before it says what it wants: the
// cheapest camera layer, and screen shares in full, since they are unreadable otherwise.
func defaultQuality(kind string) Quality {
	if kind == KindScreen {
		return QualityHigh
	}
	return QualityLow
}

// subscriptions lists the publications this peer receives.
func (p *Peer) subscriptions() []*Publication {
	p.mu.Lock()
	defer p.mu.Unlock()
	pubs := make([]*Publication, 0, len(p.subs))
	for _, sub := range p.subs {
		pubs = append(pubs, sub.pub)
	}
	return pubs
}

// usable reports whether the connection can still carry media. A browser that
// vanished without hanging up leaves a dead one behind.
func (p *Peer) usable() bool {
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return false
	}
	switch p.pc.ConnectionState() {
	case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
		return false
	default:
		return true
	}
}

// close tears the connection down. It is idempotent; a leave, a failed
// connection and a room shutdown can race.
func (p *Peer) close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	for _, sub := range p.subs {
		sub.down.close()
	}
	p.subs = map[string]*subscription{}
	p.mu.Unlock()

	if err := p.pc.Close(); err != nil {
		slog.Debug("sfu: close peer connection", "peer", p.id, "error", err)
	}
}

// readSenderRTCP drains the feedback a subscriber sends about a forwarded track.
// Unread RTCP backs up Pion's buffers, and a subscriber asking for a keyframe has
// to be relayed to the publisher: the SFU cannot make one itself.
func readSenderRTCP(sender *webrtc.RTPSender, down *DownTrack) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				down.requestKeyframe()
			}
		}
	}
}
