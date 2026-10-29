package meeting

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/Robinaditya1045/open-meet/server/internal/sfu"
	"github.com/pion/webrtc/v4"
)

var (
	ErrNotFound = errors.New("meeting not found")
	ErrFull     = errors.New("meeting is full")
	// errGone means a live meeting emptied and shut down between being looked up
	// and being joined; the caller looks it up again.
	errGone = errors.New("meeting shut down")
)

// MediaRoom is the slice of the SFU a meeting drives.
type MediaRoom interface {
	HandleOffer(peerID, sdp string, streams map[string]string, restart bool) error
	HandleAnswer(peerID, sdp string, streams map[string]string) error
	AddCandidate(peerID string, c webrtc.ICECandidateInit) error
	SetPreferences(peerID string, prefs map[string]sfu.Quality)
	Resync(peerID string)
	RemovePeer(peerID string)
	Close()
}

// MediaFactory creates a meeting's media room when its first participant is let in.
type MediaFactory func(code string, signaler sfu.Signaler) MediaRoom

// EngineMedia adapts an SFU engine to a MediaFactory.
func EngineMedia(e *sfu.Engine) MediaFactory {
	return func(code string, signaler sfu.Signaler) MediaRoom {
		return e.NewRoom(code, signaler)
	}
}

// Options tune every meeting the registry hosts.
type Options struct {
	MaxParticipants int
	// ReconnectGrace is how long a participant whose connection dropped keeps
	// their place, media and hand raise.
	ReconnectGrace time.Duration
	// ICEServers are handed to browsers. Usually empty, since the SFU is
	// reachable directly; a TURN server helps the most locked-down networks.
	ICEServers []ICEServer
	Now        func() time.Time
}

// Summary is what a would-be participant sees before joining.
type Summary struct {
	Code             string   `json:"code"`
	ParticipantCount int      `json:"participant_count"`
	Names            []string `json:"names"`
	Locked           bool     `json:"locked"`
}

// Registry owns every meeting: records in the store, and the live state of the
// ones with someone in them.
type Registry struct {
	store Store
	media MediaFactory
	opts  Options

	mu   sync.Mutex
	live map[string]*Meeting
}

// NewRegistry creates a registry. media may be nil, for a registry without calls.
func NewRegistry(store Store, media MediaFactory, opts Options) *Registry {
	if opts.MaxParticipants <= 0 {
		opts.MaxParticipants = 50
	}
	if opts.ReconnectGrace <= 0 {
		opts.ReconnectGrace = 20 * time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ICEServers == nil {
		opts.ICEServers = []ICEServer{}
	}
	return &Registry{store: store, media: media, opts: opts, live: map[string]*Meeting{}}
}

// Create starts a new meeting and returns it with the key that makes its holder a host.
func (r *Registry) Create() (Record, string, error) {
	now := r.opts.Now()
	for range 5 {
		code := NewCode()
		if _, taken := r.store.Get(code); taken {
			continue
		}
		hostKey := newSecret()
		rec := Record{
			Code:        code,
			HostKeyHash: hashSecret(hostKey),
			CreatedAt:   now,
			LastUsedAt:  now,
			Settings:    DefaultSettings(),
		}
		if err := r.store.Put(rec); err != nil {
			return Record{}, "", fmt.Errorf("save meeting: %w", err)
		}
		return rec, hostKey, nil
	}
	return Record{}, "", errors.New("could not allocate a meeting code")
}

// Summary describes a meeting for its green room.
func (r *Registry) Summary(code string) (Summary, error) {
	rec, ok := r.store.Get(code)
	if !ok {
		return Summary{}, ErrNotFound
	}
	s := Summary{Code: code, Names: []string{}, Locked: rec.Settings.Locked}

	r.mu.Lock()
	m := r.live[code]
	r.mu.Unlock()
	if m != nil {
		s.ParticipantCount, s.Names, s.Locked = m.summary()
	}
	return s, nil
}

// Open returns the live meeting for code, starting it if nobody is in it yet.
func (r *Registry) Open(code string) (*Meeting, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.live[code]; ok {
		return m, nil
	}
	rec, ok := r.store.Get(code)
	if !ok {
		return nil, ErrNotFound
	}
	rec.LastUsedAt = r.opts.Now()
	if err := r.store.Put(rec); err != nil {
		slog.Warn("could not record meeting use", "code", code, "error", err)
	}
	m := newMeeting(r, rec)
	r.live[code] = m
	return m, nil
}

// Join opens a meeting and joins it, retrying if the live meeting shut down in
// between.
func (r *Registry) Join(code string, conn Conn, req JoinRequest) (*Session, error) {
	for range 3 {
		m, err := r.Open(code)
		if err != nil {
			return nil, err
		}
		s, err := m.Join(conn, req)
		if errors.Is(err, errGone) {
			continue
		}
		return s, err
	}
	return nil, errGone
}

// release shuts a live meeting down once nobody is in it or waiting for it.
func (r *Registry) release(m *Meeting) {
	r.mu.Lock()
	media, released := m.shutDownIfEmpty()
	if released && r.live[m.code] == m {
		delete(r.live, m.code)
	}
	r.mu.Unlock()
	if media != nil {
		media.Close()
	}
	if released {
		slog.Info("meeting emptied", "code", m.code)
	}
}

// forget drops a meeting that was ended outright.
func (r *Registry) forget(m *Meeting) {
	r.mu.Lock()
	if r.live[m.code] == m {
		delete(r.live, m.code)
	}
	r.mu.Unlock()
}

func (r *Registry) saveSettings(code string, s Settings) {
	rec, ok := r.store.Get(code)
	if !ok {
		return
	}
	rec.Settings = s
	if err := r.store.Put(rec); err != nil {
		slog.Warn("could not save meeting settings", "code", code, "error", err)
	}
}

// Stats is a snapshot for health checks.
type Stats struct {
	LiveMeetings int `json:"live_meetings"`
	Participants int `json:"participants"`
}

func (r *Registry) Stats() Stats {
	r.mu.Lock()
	meetings := make([]*Meeting, 0, len(r.live))
	for _, m := range r.live {
		meetings = append(meetings, m)
	}
	r.mu.Unlock()

	s := Stats{LiveMeetings: len(meetings)}
	for _, m := range meetings {
		n, _, _ := m.summary()
		s.Participants += n
	}
	return s
}

// Shutdown disconnects everyone so they reconnect once the server is back.
func (r *Registry) Shutdown() {
	r.mu.Lock()
	meetings := make([]*Meeting, 0, len(r.live))
	for _, m := range r.live {
		meetings = append(meetings, m)
	}
	r.live = map[string]*Meeting{}
	r.mu.Unlock()

	for _, m := range meetings {
		m.shutdown()
	}
}

// Prune forgets meetings nobody has used since before cutoff.
func (r *Registry) Prune(cutoff time.Time) {
	n, err := r.store.Prune(cutoff)
	if err != nil {
		slog.Warn("could not prune old meetings", "error", err)
		return
	}
	if n > 0 {
		slog.Info("pruned unused meetings", "count", n)
	}
}
