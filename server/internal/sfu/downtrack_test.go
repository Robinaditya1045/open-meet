package sfu

import (
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
)

type recorder struct {
	mu      sync.Mutex
	packets []rtp.Packet
}

func (r *recorder) WriteRTP(p *rtp.Packet) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := *p
	cp.Payload = append([]byte(nil), p.Payload...)
	r.packets = append(r.packets, cp)
	return nil
}

func (r *recorder) all() []rtp.Packet {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]rtp.Packet(nil), r.packets...)
}

// vp8Payload builds a payload with a 15-bit picture ID and TL0PICIDX, followed by
// a VP8 payload header whose P bit marks a keyframe or not.
func vp8Payload(pictureID uint16, tl0 uint8, start, keyframe bool) []byte {
	b0 := byte(0x80) // X
	if start {
		b0 |= 0x10 // S, partition 0
	}
	header := byte(0x01) // P=1: interframe
	if keyframe {
		header = 0x00
	}
	return []byte{b0, 0xC0, 0x80 | byte(pictureID>>8), byte(pictureID), tl0, header, 0xAA, 0xBB}
}

type layerSource struct {
	seq uint16
	ts  uint32
	pic uint16
	tl0 uint8
}

// frame produces the packets of one frame of a layer: a start packet and a
// continuation.
func (s *layerSource) frame(keyframe bool) []*rtp.Packet {
	s.pic = (s.pic + 1) & 0x7fff
	s.ts += 3000
	if keyframe {
		s.tl0++
	}
	var out []*rtp.Packet
	for i := range 2 {
		s.seq++
		out = append(out, &rtp.Packet{
			Header:  rtp.Header{Version: 2, SequenceNumber: s.seq, Timestamp: s.ts, Marker: i == 1},
			Payload: vp8Payload(s.pic, s.tl0, i == 0, keyframe && i == 0),
		})
	}
	return out
}

func feed(d *DownTrack, layer int, pkts []*rtp.Packet) {
	for _, p := range pkts {
		desc := parseVP8(p.Payload)
		d.write(layer, p, &desc)
	}
}

func allLayers() layerState {
	return layerState{exists: [maxLayers]bool{true, true, true}, active: [maxLayers]bool{true, true, true}}
}

func TestPickLayer(t *testing.T) {
	cases := []struct {
		name      string
		requested Quality
		layers    layerState
		want      int
	}{
		{"off", QualityOff, allLayers(), noLayer},
		{"exact", QualityMedium, allLayers(), 1},
		{"falls back below", QualityHigh, layerState{exists: [3]bool{true, true, true}, active: [3]bool{true, true, false}}, 1},
		{"goes above when nothing below", QualityLow, layerState{exists: [3]bool{false, true, true}, active: [3]bool{false, true, true}}, 1},
		{"single layer", QualityHigh, layerState{exists: [3]bool{true}, active: [3]bool{true}}, 0},
		{"nothing arriving uses what exists", QualityHigh, layerState{exists: [3]bool{true, true}}, 1},
		{"nothing at all", QualityHigh, layerState{}, noLayer},
	}
	for _, tc := range cases {
		if got := pickLayer(tc.requested, tc.layers); got != tc.want {
			t.Errorf("%s: pickLayer = %d, want %d", tc.name, got, tc.want)
		}
	}
}

func TestDownTrackWaitsForKeyframeThenSwitchesSeamlessly(t *testing.T) {
	out := &recorder{}
	var requested []int
	d := newDownTrack("sub", "camera.pub", true, 90000, out,
		func(l int) { requested = append(requested, l) }, allLayers, QualityLow)
	now := time.Unix(1000, 0)
	d.now = func() time.Time { return now }

	low := &layerSource{seq: 100, ts: 5000, pic: 40, tl0: 7}
	high := &layerSource{seq: 60000, ts: 900000, pic: 30000, tl0: 200}

	d.reevaluate()
	if len(requested) != 1 || requested[0] != 0 {
		t.Fatalf("starting should ask layer 0 for a keyframe, asked %v", requested)
	}

	// Interframes are useless to a subscriber that has nothing yet.
	feed(d, 0, low.frame(false))
	if n := len(out.all()); n != 0 {
		t.Fatalf("forwarded %d packets before a keyframe", n)
	}
	feed(d, 0, low.frame(true))
	feed(d, 0, low.frame(false))
	feed(d, 2, high.frame(false))
	if n := len(out.all()); n != 4 {
		t.Fatalf("forwarded %d packets, want 4 from layer 0 only", n)
	}

	// Ask for high: low keeps flowing until high produces a keyframe.
	d.SetQuality(QualityHigh)
	if requested[len(requested)-1] != 2 {
		t.Fatalf("switching up should ask layer 2 for a keyframe, asked %v", requested)
	}
	feed(d, 2, high.frame(false))
	feed(d, 0, low.frame(false))
	now = now.Add(33 * time.Millisecond)
	feed(d, 2, high.frame(true))
	feed(d, 0, low.frame(false))
	feed(d, 2, high.frame(false))

	pkts := out.all()
	if len(pkts) != 10 {
		t.Fatalf("forwarded %d packets, want 10", len(pkts))
	}
	for i := 1; i < len(pkts); i++ {
		if pkts[i].SequenceNumber != pkts[i-1].SequenceNumber+1 {
			t.Fatalf("sequence gap at %d: %d after %d", i, pkts[i].SequenceNumber, pkts[i-1].SequenceNumber)
		}
	}
	var lastPic uint16
	var lastTS uint32
	for i, p := range pkts {
		desc := parseVP8(p.Payload)
		if i > 0 && p.Timestamp != lastTS {
			if desc.pictureID != (lastPic+1)&0x7fff {
				t.Fatalf("picture id jumped from %d to %d at packet %d", lastPic, desc.pictureID, i)
			}
			if p.Timestamp-lastTS > 90000 {
				t.Fatalf("timestamp jumped by %d at packet %d", p.Timestamp-lastTS, i)
			}
		}
		lastPic, lastTS = desc.pictureID, p.Timestamp
	}
	if d.activeLayer() != 2 {
		t.Fatalf("active layer = %d, want 2", d.activeLayer())
	}
}

func TestDownTrackPauseAndResume(t *testing.T) {
	out := &recorder{}
	d := newDownTrack("sub", "camera.pub", true, 90000, out, func(int) {}, allLayers, QualityMedium)
	d.reevaluate()
	src := &layerSource{seq: 10, ts: 10, pic: 1, tl0: 1}
	feed(d, 1, src.frame(true))

	d.SetQuality(QualityOff)
	for range 5 {
		feed(d, 1, src.frame(false))
	}
	if n := len(out.all()); n != 2 {
		t.Fatalf("forwarded %d packets while paused, want only the 2 before", n)
	}

	d.SetQuality(QualityMedium)
	feed(d, 1, src.frame(false))
	feed(d, 1, src.frame(true))
	pkts := out.all()
	if len(pkts) != 4 {
		t.Fatalf("forwarded %d packets, want 4", len(pkts))
	}
	// Resuming continues the numbering instead of leaving a gap the subscriber
	// would try to NACK.
	if pkts[2].SequenceNumber != pkts[1].SequenceNumber+1 {
		t.Fatalf("resume left a sequence gap: %d after %d", pkts[2].SequenceNumber, pkts[1].SequenceNumber)
	}
}

func TestDownTrackAudioForwardsEverything(t *testing.T) {
	out := &recorder{}
	d := newDownTrack("sub", "mic.pub", false, 48000, out, func(int) {}, func() layerState { return layerState{} }, QualityLow)
	for i := range 5 {
		d.write(0, &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(65533 + i), Timestamp: uint32(960 * i)}, Payload: []byte{1}}, nil)
	}
	pkts := out.all()
	if len(pkts) != 5 {
		t.Fatalf("forwarded %d audio packets, want 5", len(pkts))
	}
	if pkts[4].SequenceNumber != 1 {
		t.Fatalf("audio sequence should pass through across wraparound, got %d", pkts[4].SequenceNumber)
	}
}

func TestDownTrackDropsStragglersFromBeforeASwitch(t *testing.T) {
	out := &recorder{}
	d := newDownTrack("sub", "camera.pub", true, 90000, out, func(int) {}, allLayers, QualityLow)
	d.reevaluate()
	src := &layerSource{seq: 500, ts: 0, pic: 0, tl0: 0}
	early := src.frame(false)
	feed(d, 0, src.frame(true))
	// A packet from before the keyframe arrives late; it belongs to nothing the
	// subscriber has.
	feed(d, 0, early[:1])
	if n := len(out.all()); n != 2 {
		t.Fatalf("forwarded %d packets, want 2", n)
	}
}

func TestParseVP8(t *testing.T) {
	d := parseVP8(vp8Payload(0x1234, 9, true, true))
	if !d.valid || !d.keyframe || !d.hasPictureID || !d.pictureIDWide || d.pictureID != 0x1234 || d.tl0PicIdx != 9 {
		t.Fatalf("unexpected descriptor %+v", d)
	}
	if parseVP8(vp8Payload(1, 1, false, true)).keyframe {
		t.Fatal("a continuation packet must not count as a keyframe start")
	}
	buf := vp8Payload(0x1234, 9, true, false)
	d = parseVP8(buf)
	d.rewrite(buf, 0x0042, 77)
	again := parseVP8(buf)
	if again.pictureID != 0x0042 || again.tl0PicIdx != 77 || !again.pictureIDWide {
		t.Fatalf("rewrite produced %+v", again)
	}
	if parseVP8(nil).valid || parseVP8([]byte{0x80}).valid {
		t.Fatal("truncated payloads must not parse")
	}
}

func TestSpeakerDetector(t *testing.T) {
	s := newSpeakerDetector()
	tick := func(levels map[string]uint8) (map[string]float64, string) {
		for id, l := range levels {
			for range 10 {
				s.observe(id, l)
			}
		}
		lv, dom, _ := s.tick()
		return lv, dom
	}
	_, dom := tick(map[string]uint8{"a": 20, "b": 127})
	if dom != "a" {
		t.Fatalf("dominant = %q, want a", dom)
	}
	// One loud tick from b is not enough to take over.
	_, dom = tick(map[string]uint8{"a": 127, "b": 15})
	if dom != "a" {
		t.Fatalf("dominant flipped after one tick to %q", dom)
	}
	_, dom = tick(map[string]uint8{"a": 127, "b": 15})
	speaking, dom := tick(map[string]uint8{"a": 127, "b": 15})
	if dom != "b" {
		t.Fatalf("dominant = %q, want b after sustained speech", dom)
	}
	levels, _ := tick(map[string]uint8{"a": 127, "b": 127})
	if levels["b"] >= speaking["b"] || levels["a"] >= speaking["a"] {
		t.Fatalf("levels should decay toward silence, went from %v to %v", speaking, levels)
	}
	for range 20 {
		levels, dom = tick(map[string]uint8{"a": 127, "b": 127})
	}
	if len(levels) != 0 || dom != "b" {
		t.Fatalf("after silence levels = %v (want none) and dominant = %q (want b kept)", levels, dom)
	}
	s.remove("b")
	if _, dom = tick(nil); dom == "b" {
		t.Fatal("removed participant is still dominant")
	}
}
