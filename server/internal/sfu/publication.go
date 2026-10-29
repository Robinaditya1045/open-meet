package sfu

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

const (
	// layerTimeout is how long a simulcast layer may go quiet before it stops
	// counting as available. Browsers drop their top layer under uplink pressure
	// and say nothing about it.
	layerTimeout = 1500 * time.Millisecond
	// keyframeThrottle bounds how often one layer is asked for a keyframe. Every
	// keyframe costs the publisher bitrate it then has to claw back from quality,
	// and a room full of subscribers joining at once would otherwise ask for one each.
	keyframeThrottle = 300 * time.Millisecond
	// layerCheckInterval is how often down tracks re-pick their layer.
	layerCheckInterval = 500 * time.Millisecond
)

// layer is one simulcast encoding of a publication (or its only encoding).
type layer struct {
	index               int
	ssrc                uint32
	lastPacket          atomic.Int64
	lastKeyframeRequest atomic.Int64
}

// Publication is one track a participant publishes: a microphone, a camera with up
// to three simulcast layers, or a screen share. It owns the read loops that pull
// the publisher's packets and fans every packet out to its down tracks.
//
// The read path takes no locks. Layers and down tracks are swapped in as whole
// copies, so the per-packet loop only ever loads a pointer.
type Publication struct {
	room     *Room
	owner    *Peer
	name     string
	kind     string
	isVideo  bool
	codec    webrtc.RTPCodecCapability
	receiver *webrtc.RTPReceiver
	// audioLevelID is the negotiated header extension ID carrying the
	// microphone level, or zero when the browser did not agree to send it.
	audioLevelID uint8

	mu     sync.Mutex
	layers atomic.Pointer[[maxLayers]*layer]
	downs  atomic.Pointer[[]*DownTrack]
	closed atomic.Bool
	done   chan struct{}
}

func newPublication(room *Room, owner *Peer, name, kind string, codec webrtc.RTPCodecCapability, receiver *webrtc.RTPReceiver) *Publication {
	pub := &Publication{
		room:     room,
		owner:    owner,
		name:     name,
		kind:     kind,
		isVideo:  kind != KindMic,
		codec:    codec,
		receiver: receiver,
		done:     make(chan struct{}),
	}
	pub.layers.Store(&[maxLayers]*layer{})
	pub.downs.Store(&[]*DownTrack{})
	if !pub.isVideo {
		for _, ext := range receiver.GetParameters().HeaderExtensions {
			if ext.URI == sdp.AudioLevelURI {
				pub.audioLevelID = uint8(ext.ID)
			}
		}
	} else {
		go pub.monitorLayers()
	}
	return pub
}

// addLayer starts forwarding one encoding of the publication.
func (p *Publication) addLayer(index int, remote *webrtc.TrackRemote) {
	p.mu.Lock()
	current := p.layers.Load()
	if p.closed.Load() || current[index] != nil {
		p.mu.Unlock()
		return
	}
	next := *current
	l := &layer{index: index, ssrc: uint32(remote.SSRC())}
	l.lastPacket.Store(time.Now().UnixNano())
	next[index] = l
	p.layers.Store(&next)
	p.mu.Unlock()

	go p.readLoop(l, remote)
}

func (p *Publication) readLoop(l *layer, remote *webrtc.TrackRemote) {
	// When the publisher goes away, so does everything it was publishing.
	defer p.room.retirePublication(p)

	buf := make([]byte, 1500)
	for {
		n, _, err := remote.Read(buf)
		if err != nil {
			return
		}
		var pkt rtp.Packet
		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}
		l.lastPacket.Store(time.Now().UnixNano())

		var desc vp8Descriptor
		if p.isVideo {
			desc = parseVP8(pkt.Payload)
		} else if p.audioLevelID != 0 {
			p.observeAudioLevel(&pkt)
		}

		for _, d := range *p.downs.Load() {
			d.write(l.index, &pkt, &desc)
		}
	}
}

func (p *Publication) observeAudioLevel(pkt *rtp.Packet) {
	raw := pkt.GetExtension(p.audioLevelID)
	if raw == nil {
		return
	}
	var level rtp.AudioLevelExtension
	if err := level.Unmarshal(raw); err != nil {
		return
	}
	p.room.speakers.observe(p.owner.id, level.Level)
}

// monitorLayers re-picks every down track's layer as the publisher's layers come
// and go, and keeps re-asking for keyframes that a pending switch is waiting on.
func (p *Publication) monitorLayers() {
	ticker := time.NewTicker(layerCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			for _, d := range *p.downs.Load() {
				d.reevaluate()
			}
		}
	}
}

// layerState reports which layers exist and which are still arriving.
func (p *Publication) layerState() layerState {
	var s layerState
	now := time.Now().UnixNano()
	for i, l := range p.layers.Load() {
		if l == nil {
			continue
		}
		s.exists[i] = true
		s.active[i] = now-l.lastPacket.Load() < int64(layerTimeout)
	}
	return s
}

// requestKeyframe asks the publisher for a keyframe on one layer.
func (p *Publication) requestKeyframe(index int) {
	if index < 0 || index >= maxLayers || p.closed.Load() {
		return
	}
	l := p.layers.Load()[index]
	if l == nil {
		return
	}
	now := time.Now().UnixNano()
	last := l.lastKeyframeRequest.Load()
	if now-last < int64(keyframeThrottle) || !l.lastKeyframeRequest.CompareAndSwap(last, now) {
		return
	}
	_ = p.owner.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: l.ssrc}})
}

// addDown attaches a down track. It reports false once the publication has been
// retired, in which case the caller must undo the subscription it just made.
func (p *Publication) addDown(d *DownTrack) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed.Load() {
		return false
	}
	current := *p.downs.Load()
	next := make([]*DownTrack, 0, len(current)+1)
	next = append(next, current...)
	next = append(next, d)
	p.downs.Store(&next)
	return true
}

// removeDown detaches the down track feeding one subscriber.
func (p *Publication) removeDown(subscriberID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	current := *p.downs.Load()
	next := make([]*DownTrack, 0, len(current))
	for _, d := range current {
		if d.subscriberID == subscriberID {
			d.close()
			continue
		}
		next = append(next, d)
	}
	p.downs.Store(&next)
}

// close stops forwarding. It reports whether this call was the one that closed it.
func (p *Publication) close() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closed.CompareAndSwap(false, true) {
		return false
	}
	close(p.done)
	for _, d := range *p.downs.Load() {
		d.close()
	}
	p.downs.Store(&[]*DownTrack{})
	return true
}
