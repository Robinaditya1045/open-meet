package meeting

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Settings are the host's choices for a meeting. They outlive any one call: a
// meeting link locked last week is still locked.
type Settings struct {
	// Locked makes everyone without host rights ask to join.
	Locked bool `json:"locked"`
	// ChatEnabled lets guests send chat messages. Hosts always can.
	ChatEnabled bool `json:"chat_enabled"`
	// ScreenShareEnabled lets guests present. Hosts always can.
	ScreenShareEnabled bool `json:"screen_share_enabled"`
	// ReactionsEnabled lets guests send emoji reactions.
	ReactionsEnabled bool `json:"reactions_enabled"`
}

// DefaultSettings is an open meeting where everyone can do everything.
func DefaultSettings() Settings {
	return Settings{ChatEnabled: true, ScreenShareEnabled: true, ReactionsEnabled: true}
}

// Record is what is kept about a meeting between calls.
type Record struct {
	Code        string    `json:"code"`
	HostKeyHash string    `json:"host_key_hash"`
	CreatedAt   time.Time `json:"created_at"`
	LastUsedAt  time.Time `json:"last_used_at"`
	Settings    Settings  `json:"settings"`
}

// Store persists meeting records. Live call state (who is in it, chat) is never
// stored: like a phone call, it ends when the last person hangs up.
type Store interface {
	Get(code string) (Record, bool)
	Put(rec Record) error
	// Prune deletes records unused since before cutoff and reports how many.
	Prune(cutoff time.Time) (int, error)
}

// MemoryStore keeps records in memory only.
type MemoryStore struct {
	mu   sync.RWMutex
	recs map[string]Record
}

// NewMemoryStore returns an empty in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{recs: map[string]Record{}}
}

func (s *MemoryStore) Get(code string) (Record, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.recs[code]
	return rec, ok
}

func (s *MemoryStore) Put(rec Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recs[rec.Code] = rec
	return nil
}

func (s *MemoryStore) Prune(cutoff time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for code, rec := range s.recs {
		if rec.LastUsedAt.Before(cutoff) {
			delete(s.recs, code)
			n++
		}
	}
	return n, nil
}

// FileStore keeps records in memory and mirrors them to a JSON file, so meeting
// links survive a restart without needing a database for what is a handful of
// fields per meeting.
type FileStore struct {
	path string
	mu   sync.Mutex
	recs map[string]Record
}

// OpenFileStore loads the store at path, creating its directory if needed.
func OpenFileStore(path string) (*FileStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	s := &FileStore{path: path, recs: map[string]Record{}}
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, fmt.Errorf("read meeting store: %w", err)
	}
	var recs []Record
	if err := json.Unmarshal(data, &recs); err != nil {
		return nil, fmt.Errorf("parse meeting store %s: %w", path, err)
	}
	for _, rec := range recs {
		s.recs[rec.Code] = rec
	}
	return s, nil
}

func (s *FileStore) Get(code string) (Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.recs[code]
	return rec, ok
}

func (s *FileStore) Put(rec Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recs[rec.Code] = rec
	return s.flushLocked()
}

func (s *FileStore) Prune(cutoff time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for code, rec := range s.recs {
		if rec.LastUsedAt.Before(cutoff) {
			delete(s.recs, code)
			n++
		}
	}
	if n == 0 {
		return 0, nil
	}
	return n, s.flushLocked()
}

// flushLocked rewrites the file through a temporary one, so a crash mid-write
// leaves the previous version rather than half of the new one.
func (s *FileStore) flushLocked() error {
	recs := make([]Record, 0, len(s.recs))
	for _, rec := range s.recs {
		recs = append(recs, rec)
	}
	data, err := json.MarshalIndent(recs, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".meetings-*.json")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}
