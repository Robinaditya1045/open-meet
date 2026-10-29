package sfu

import "strings"

// Media kinds a participant can publish. A participant publishes at most one of each.
const (
	KindMic    = "mic"
	KindCamera = "camera"
	KindScreen = "screen"
)

func validKind(kind string) bool {
	switch kind {
	case KindMic, KindCamera, KindScreen:
		return true
	default:
		return false
	}
}

// trackNameSeparator is a dot because participant IDs never contain one, and dots
// are valid in the SDP token that carries a track name to the browser.
const trackNameSeparator = "."

// TrackName is the identity the SFU gives a forwarded track: "<kind>.<participantID>".
//
// The publisher's browser names its tracks with random IDs that tell a subscriber
// nothing. Renaming both halves of the msid after the owner is what lets the far
// side put a camera on the right tile and tell it apart from a screen share.
func TrackName(kind, participantID string) string {
	return kind + trackNameSeparator + participantID
}

// SplitTrackName recovers the kind and publisher from a name built by TrackName.
func SplitTrackName(name string) (kind, participantID string, ok bool) {
	kind, participantID, ok = strings.Cut(name, trackNameSeparator)
	if !ok || participantID == "" || !validKind(kind) {
		return "", "", false
	}
	return kind, participantID, true
}

// Quality is how much of a video publication a subscriber wants.
type Quality int

// Qualities, ordered so that a higher value never wants less. They map one to one
// onto simulcast layers, with QualityOff meaning "forward nothing".
const (
	QualityOff Quality = iota - 1
	QualityLow
	QualityMedium
	QualityHigh
)

// ParseQuality reads the wire name of a quality.
func ParseQuality(s string) (Quality, bool) {
	switch s {
	case "off":
		return QualityOff, true
	case "low":
		return QualityLow, true
	case "medium":
		return QualityMedium, true
	case "high":
		return QualityHigh, true
	default:
		return QualityOff, false
	}
}

// maxLayers is the number of simulcast layers a publication can carry.
const maxLayers = 3

// ridLayer maps a simulcast RID onto a layer index. The client sends quarter, half
// and full resolution as "q", "h" and "f"; a track without a RID is not simulcast
// and is its own only layer.
func ridLayer(rid string) int {
	switch rid {
	case "q", "":
		return 0
	case "h":
		return 1
	case "f":
		return 2
	default:
		return -1
	}
}
