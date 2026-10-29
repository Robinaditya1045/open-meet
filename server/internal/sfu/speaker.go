package sfu

import (
	"math"
	"sync"
)

const (
	// speakingThreshold is the smoothed loudness above which someone counts as
	// speaking for the purposes of taking over as dominant speaker.
	speakingThreshold = 0.2
	// takeoverMargin is how much louder than the current dominant speaker a
	// contender must be, so two people talking over each other do not make the
	// spotlight flicker between them.
	takeoverMargin = 0.08
	// takeoverTicks is how many consecutive ticks a contender must stay ahead.
	takeoverTicks = 2
	// reportDelta is the smallest level change worth sending to clients.
	reportDelta = 0.04
)

// amplitude[l] converts an RFC 6464 audio level (-dBov, 0 loudest, 127 silent)
// into linear amplitude, so averaging over a tick weights loud packets properly
// instead of letting a burst of near-silence drown out a word.
var amplitude = func() (t [128]float64) {
	for l := range t {
		t[l] = math.Pow(10, -float64(l)/20)
	}
	return t
}()

type levelAccumulator struct {
	sum   float64
	count int
}

// speakerDetector turns the audio levels every browser stamps on its microphone
// packets into per-participant loudness and a dominant speaker.
//
// Doing this on the server rather than in each browser means everyone agrees on
// who is speaking, costs no audio decoding anywhere, and works for participants
// whose audio a given browser has not even started playing yet.
type speakerDetector struct {
	mu             sync.Mutex
	acc            map[string]*levelAccumulator
	smoothed       map[string]float64
	sent           map[string]float64
	dominant       string
	contender      string
	contenderTicks int
}

func newSpeakerDetector() *speakerDetector {
	return &speakerDetector{
		acc:      map[string]*levelAccumulator{},
		smoothed: map[string]float64{},
		sent:     map[string]float64{},
	}
}

func (s *speakerDetector) observe(id string, level uint8) {
	if level > 127 {
		level = 127
	}
	s.mu.Lock()
	a := s.acc[id]
	if a == nil {
		a = &levelAccumulator{}
		s.acc[id] = a
	}
	a.sum += amplitude[level]
	a.count++
	s.mu.Unlock()
}

func (s *speakerDetector) remove(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.acc, id)
	delete(s.smoothed, id)
	if s.dominant == id {
		s.dominant = ""
	}
	if s.contender == id {
		s.contender = ""
		s.contenderTicks = 0
	}
}

// tick closes one measurement window. It returns the levels worth reporting and
// the dominant speaker, and whether either moved enough to be worth sending.
func (s *speakerDetector) tick() (levels map[string]float64, dominant string, changed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, a := range s.acc {
		loudness := 0.0
		if a.count > 0 {
			db := 20 * math.Log10(a.sum/float64(a.count))
			// -55 dBov and below is room tone; -15 dBov is someone close to the mic.
			loudness = math.Max(0, math.Min(1, (db+55)/40))
		}
		a.sum, a.count = 0, 0

		prev := s.smoothed[id]
		// Fast attack so the ring lights up with the first syllable, slower
		// release so it does not strobe between words.
		if loudness > prev {
			s.smoothed[id] = prev + (loudness-prev)*0.7
		} else {
			s.smoothed[id] = prev + (loudness-prev)*0.35
		}
	}

	best, bestLevel := "", 0.0
	for id, l := range s.smoothed {
		if l > bestLevel || (l == bestLevel && id < best) {
			best, bestLevel = id, l
		}
	}
	if best != "" && best != s.dominant && bestLevel >= speakingThreshold &&
		bestLevel > s.smoothed[s.dominant]+takeoverMargin {
		if s.contender == best {
			s.contenderTicks++
		} else {
			s.contender, s.contenderTicks = best, 1
		}
		if s.contenderTicks >= takeoverTicks || s.dominant == "" {
			s.dominant = best
			s.contender, s.contenderTicks = "", 0
			changed = true
		}
	} else {
		s.contender, s.contenderTicks = "", 0
	}

	levels = make(map[string]float64)
	for id, l := range s.smoothed {
		if l >= 0.02 {
			levels[id] = math.Round(l*100) / 100
		}
	}
	for id, l := range levels {
		if math.Abs(l-s.sent[id]) >= reportDelta {
			changed = true
		}
	}
	for id := range s.sent {
		if _, ok := levels[id]; !ok {
			changed = true
		}
	}
	if changed {
		s.sent = levels
	}
	return levels, s.dominant, changed
}
