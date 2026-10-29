package sfu

import (
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
)

const noLayer = -1

// keyframeRetry is how long a pending layer switch waits for its keyframe before
// asking again. A PLI is a single unacknowledged packet and can be lost.
const keyframeRetry = time.Second

// rtpWriter is where a down track's packets go: a TrackLocalStaticRTP in
// production, a recorder in tests.
type rtpWriter interface {
	WriteRTP(*rtp.Packet) error
}

// layerState is what a publication currently has to offer: which simulcast layers
// it has ever received, and which of those are still arriving.
type layerState struct {
	exists [maxLayers]bool
	active [maxLayers]bool
}

// pickLayer chooses the layer that best serves a requested quality: the highest
// one at or below it, else the lowest above it. Layers that are actually arriving
// win over ones that merely exist — a browser short of uplink stops sending its
// top layer, and waiting for a keyframe that will never come is a frozen tile.
func pickLayer(requested Quality, layers layerState) int {
	if requested == QualityOff {
		return noLayer
	}
	candidates := layers.active
	arriving := false
	for _, a := range candidates {
		arriving = arriving || a
	}
	if !arriving {
		candidates = layers.exists
	}
	want := int(requested)
	for l := min(want, maxLayers-1); l >= 0; l-- {
		if candidates[l] {
			return l
		}
	}
	for l := want + 1; l < maxLayers; l++ {
		if candidates[l] {
			return l
		}
	}
	return noLayer
}

// DownTrack carries one publication to one subscriber.
//
// Video is where it earns its keep. A simulcast publisher sends up to three
// independent encodings, each with its own sequence numbers, timestamps and VP8
// picture IDs; the subscriber must see exactly one continuous stream. So the down
// track forwards a single layer at a time, switches only on a keyframe of the
// layer it is moving to (anything else is undecodable), and renumbers every packet
// so the splice is invisible. Pausing — a tile scrolled out of view — is the same
// mechanism with no layer at all, and resuming is a switch like any other.
type DownTrack struct {
	subscriberID string
	pubName      string
	isVideo      bool
	clockRate    uint32

	out      rtpWriter
	keyframe func(layer int)
	layers   func() layerState
	now      func() time.Time

	mu        sync.Mutex
	closed    bool
	requested Quality
	// current is the layer being forwarded; target the one being switched to,
	// waiting for its next keyframe.
	current, target int
	targetSince     time.Time
	// needRebase marks the next forwarded packet as the start of a new segment,
	// whose numbering has to be joined onto what the subscriber already has.
	needRebase bool

	wrote         bool
	lastSeq       uint16
	lastTS        uint32
	lastAt        time.Time
	lastPictureID uint16
	lastTL0       uint8

	seqOffset uint16
	tsOffset  uint32
	picOffset uint16
	tl0Offset uint8
	// baseSeq is the first input sequence number of the current segment. A
	// straggler from before it belongs to whatever was forwarded previously and
	// would land on numbers the subscriber already has.
	baseSeq uint16

	scratch []byte

	// forwarded counts packets handed to the subscriber's connection.
	forwarded atomic.Uint64
}

func newDownTrack(subscriberID, pubName string, isVideo bool, clockRate uint32, out rtpWriter,
	keyframe func(layer int), layers func() layerState, requested Quality,
) *DownTrack {
	return &DownTrack{
		subscriberID: subscriberID,
		pubName:      pubName,
		isVideo:      isVideo,
		clockRate:    clockRate,
		out:          out,
		keyframe:     keyframe,
		layers:       layers,
		now:          time.Now,
		requested:    requested,
		current:      noLayer,
		target:       noLayer,
		needRebase:   true,
	}
}

// SetQuality changes what the subscriber wants and starts moving towards it.
func (d *DownTrack) SetQuality(q Quality) {
	d.mu.Lock()
	changed := d.requested != q
	d.requested = q
	d.mu.Unlock()
	if changed {
		d.reevaluate()
	}
}

// reevaluate moves the down track towards the best layer for what was requested,
// given what the publisher is currently sending.
func (d *DownTrack) reevaluate() {
	if !d.isVideo {
		return
	}
	layers := d.layers()

	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	want := pickLayer(d.requested, layers)
	if want == noLayer {
		if d.requested == QualityOff {
			d.current, d.target = noLayer, noLayer
		}
		return
	}
	if want == d.current {
		d.target = noLayer
		return
	}
	now := d.now()
	if d.target != want {
		d.target = want
		d.targetSince = now
		d.keyframe(want)
		return
	}
	if now.Sub(d.targetSince) > keyframeRetry {
		d.targetSince = now
		d.keyframe(want)
	}
}

// requestKeyframe relays a subscriber's PLI or FIR to whichever layer it needs a
// keyframe from.
func (d *DownTrack) requestKeyframe() {
	d.mu.Lock()
	layer := d.target
	if layer == noLayer {
		layer = d.current
	}
	d.mu.Unlock()
	if layer != noLayer {
		d.keyframe(layer)
	}
}

// write forwards one packet from layer of the publication, if it belongs to what
// this subscriber is being sent.
func (d *DownTrack) write(layer int, pkt *rtp.Packet, desc *vp8Descriptor) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}

	if d.isVideo {
		if d.target != noLayer && layer == d.target && desc.keyframe {
			d.current = d.target
			d.target = noLayer
			d.needRebase = true
		}
		if layer != d.current {
			return
		}
	}

	if d.needRebase {
		if d.isVideo && !desc.keyframe {
			return
		}
		d.rebase(pkt, desc)
	} else if seqBefore(pkt.SequenceNumber, d.baseSeq) {
		return
	}

	out := rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			Padding:        pkt.Padding,
			PaddingSize:    pkt.Header.PaddingSize,
			Marker:         pkt.Marker,
			PayloadType:    pkt.PayloadType,
			SequenceNumber: pkt.SequenceNumber - d.seqOffset,
			Timestamp:      pkt.Timestamp - d.tsOffset,
			CSRC:           pkt.CSRC,
			// Header extensions are left behind on purpose. Their IDs were
			// negotiated with the publisher, not with this subscriber, and the
			// subscriber's own interceptors add the ones it needs.
		},
		Payload: pkt.Payload,
	}

	var pictureID uint16
	var tl0 uint8
	if d.isVideo && desc.valid {
		pictureID = (desc.pictureID - d.picOffset) & desc.pictureIDMask()
		tl0 = desc.tl0PicIdx - d.tl0Offset
		if (desc.hasPictureID && d.picOffset != 0) || (desc.hasTL0PicIdx && d.tl0Offset != 0) {
			// The payload is shared with every other subscriber of this layer.
			d.scratch = append(d.scratch[:0], pkt.Payload...)
			desc.rewrite(d.scratch, pictureID, tl0)
			out.Payload = d.scratch
		}
	}

	if !d.wrote || seqAfter(out.SequenceNumber, d.lastSeq) {
		d.lastSeq = out.SequenceNumber
		d.lastTS = out.Timestamp
		if desc != nil && desc.hasPictureID {
			d.lastPictureID = pictureID
		}
		if desc != nil && desc.hasTL0PicIdx {
			d.lastTL0 = tl0
		}
	}
	d.wrote = true
	d.lastAt = d.now()
	// Keep the straggler cut-off within half the sequence space of what is being
	// forwarded, or wraparound would eventually make new packets look old.
	if uint16(pkt.SequenceNumber-d.baseSeq) > 0x4000 {
		d.baseSeq = pkt.SequenceNumber - 0x2000
	}

	d.forwarded.Add(1)
	if err := d.out.WriteRTP(&out); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		slog.Debug("sfu down track write failed", "subscriber", d.subscriberID, "track", d.pubName, "error", err)
	}
}

// rebase joins a new segment onto the numbering the subscriber has seen so far:
// the first packet of the segment follows the last one sent, in sequence number,
// in picture ID and in time.
func (d *DownTrack) rebase(pkt *rtp.Packet, desc *vp8Descriptor) {
	if d.wrote {
		d.seqOffset = pkt.SequenceNumber - d.lastSeq - 1
		elapsed := d.now().Sub(d.lastAt)
		ticks := uint32(elapsed.Seconds() * float64(d.clockRate))
		// Two frames must never share a timestamp; a receiver would try to
		// assemble them into one.
		if minTicks := d.clockRate / 100; ticks < minTicks {
			ticks = minTicks
		}
		d.tsOffset = pkt.Timestamp - d.lastTS - ticks
		if desc != nil && desc.hasPictureID {
			d.picOffset = desc.pictureID - d.lastPictureID - 1
		}
		if desc != nil && desc.hasTL0PicIdx {
			d.tl0Offset = desc.tl0PicIdx - d.lastTL0 - 1
		}
	}
	d.baseSeq = pkt.SequenceNumber
	d.needRebase = false
}

// activeLayer reports the layer being forwarded, or noLayer.
func (d *DownTrack) activeLayer() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.current
}

func (d *DownTrack) close() {
	d.mu.Lock()
	d.closed = true
	d.mu.Unlock()
}

// seqAfter reports whether a comes after b in RTP sequence space.
func seqAfter(a, b uint16) bool {
	return a != b && a-b < 0x8000
}

// seqBefore reports whether a comes before b in RTP sequence space.
func seqBefore(a, b uint16) bool {
	return a != b && b-a < 0x8000
}
