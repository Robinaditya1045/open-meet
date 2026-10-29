package meeting

import (
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Robinaditya1045/open-meet/server/internal/sfu"
	"github.com/pion/webrtc/v4"
)

type message struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type fakeConn struct {
	mu     sync.Mutex
	msgs   []message
	closed bool
	code   int
}

func (c *fakeConn) Send(b []byte) bool {
	var m message
	if err := json.Unmarshal(b, &m); err != nil {
		panic(err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	c.msgs = append(c.msgs, m)
	return true
}

func (c *fakeConn) Close(code int, _ string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed, c.code = true, code
	}
}

// last decodes the most recent message of a type into v, reporting whether there was one.
func (c *fakeConn) last(msgType string, v any) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.msgs) - 1; i >= 0; i-- {
		if c.msgs[i].Type == msgType {
			if v != nil {
				if err := json.Unmarshal(c.msgs[i].Data, v); err != nil {
					panic(err)
				}
			}
			return true
		}
	}
	return false
}

func (c *fakeConn) closeCode() (bool, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed, c.code
}

type fakeMedia struct {
	mu      sync.Mutex
	removed []string
	closed  bool
}

func (f *fakeMedia) HandleOffer(string, string, map[string]string, bool) error { return nil }
func (f *fakeMedia) HandleAnswer(string, string, map[string]string) error      { return nil }
func (f *fakeMedia) AddCandidate(string, webrtc.ICECandidateInit) error        { return nil }
func (f *fakeMedia) SetPreferences(string, map[string]sfu.Quality)             {}
func (f *fakeMedia) Resync(string)                                             {}
func (f *fakeMedia) RemovePeer(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, id)
}
func (f *fakeMedia) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
}

type harness struct {
	t     *testing.T
	reg   *Registry
	media *fakeMedia
	code  string
	key   string
}

func newHarness(t *testing.T, grace time.Duration) *harness {
	t.Helper()
	h := &harness{t: t, media: &fakeMedia{}}
	h.reg = NewRegistry(NewMemoryStore(), func(string, sfu.Signaler) MediaRoom { return h.media },
		Options{ReconnectGrace: grace, MaxParticipants: 4})
	rec, key, err := h.reg.Create()
	if err != nil {
		t.Fatal(err)
	}
	h.code, h.key = rec.Code, key
	return h
}

func (h *harness) join(name, hostKey, resume string) (*fakeConn, *Session) {
	h.t.Helper()
	conn := &fakeConn{}
	s, err := h.reg.Join(h.code, conn, JoinRequest{Name: name, HostKey: hostKey, ResumeToken: resume})
	if err != nil {
		h.t.Fatalf("join %s: %v", name, err)
	}
	return conn, s
}

func send(s *Session, msgType string, data any) {
	raw, _ := json.Marshal(data)
	s.Handle(msgType, raw)
}

func roster(t *testing.T, c *fakeConn) []ParticipantInfo {
	t.Helper()
	var p participantsPayload
	if !c.last(MsgParticipants, &p) {
		t.Fatal("no roster received")
	}
	return p.Participants
}

func find(t *testing.T, r []ParticipantInfo, id string) ParticipantInfo {
	t.Helper()
	for _, p := range r {
		if p.ID == id {
			return p
		}
	}
	t.Fatalf("participant %s not in roster %+v", id, r)
	return ParticipantInfo{}
}

func TestHostAndGuestJoin(t *testing.T) {
	h := newHarness(t, time.Minute)
	hostConn, _ := h.join("  Ada   Lovelace ", h.key, "")
	var joined joinedPayload
	if !hostConn.last(MsgJoined, &joined) {
		t.Fatal("host was not let in")
	}
	if !joined.Self.IsHost || joined.Self.Name != "Ada Lovelace" || joined.ResumeToken == "" {
		t.Fatalf("unexpected host join %+v", joined.Self)
	}

	guestConn, _ := h.join("", "wrong-key", "")
	if !guestConn.last(MsgJoined, &joined) || joined.Self.IsHost || joined.Self.Name != "Guest" {
		t.Fatalf("unexpected guest join %+v", joined.Self)
	}
	if len(joined.Participants) != 2 {
		t.Fatalf("guest sees %d participants, want 2", len(joined.Participants))
	}
	if got := roster(t, hostConn); len(got) != 2 || find(t, got, joined.Self.ID).Name != "Guest" {
		t.Fatalf("host roster = %+v", got)
	}
}

func TestLockedMeetingAsksHostToAdmit(t *testing.T) {
	h := newHarness(t, time.Minute)
	hostConn, host := h.join("Host", h.key, "")
	send(host, MsgSettings, map[string]bool{"locked": true})

	knocker, _ := h.join("Knocker", "", "")
	if !knocker.last(MsgWaiting, nil) || knocker.last(MsgJoined, nil) {
		t.Fatal("a guest got into a locked meeting without being admitted")
	}
	var lobby lobbyPayload
	if !hostConn.last(MsgLobby, &lobby) || len(lobby.Lobby) != 1 || lobby.Lobby[0].Name != "Knocker" {
		t.Fatalf("host lobby = %+v", lobby)
	}

	send(host, MsgAdmit, targetPayload{ParticipantID: lobby.Lobby[0].ID})
	if !knocker.last(MsgJoined, nil) {
		t.Fatal("admitted guest was not let in")
	}

	denied, _ := h.join("Unwelcome", "", "")
	hostConn.last(MsgLobby, &lobby)
	send(host, MsgDeny, targetPayload{ParticipantID: lobby.Lobby[0].ID})
	if closed, code := denied.closeCode(); !closed || code != CloseDenied {
		t.Fatalf("denied guest: closed=%v code=%d", closed, code)
	}
	if hostConn.last(MsgLobby, &lobby); len(lobby.Lobby) != 0 {
		t.Fatalf("lobby still has %+v", lobby.Lobby)
	}

	// Unlocking lets in everyone still waiting.
	waiting, _ := h.join("Patient", "", "")
	send(host, MsgSettings, map[string]bool{"locked": false})
	if !waiting.last(MsgJoined, nil) {
		t.Fatal("unlocking did not admit the waiting guest")
	}
}

func TestDroppedConnectionKeepsPlaceUntilGraceExpires(t *testing.T) {
	h := newHarness(t, 80*time.Millisecond)
	hostConn, _ := h.join("Host", h.key, "")
	guestConn, guest := h.join("Guest", "", "")
	var joined joinedPayload
	guestConn.last(MsgJoined, &joined)

	guest.Closed()
	if r := roster(t, hostConn); len(r) != 2 || find(t, r, joined.Self.ID).Connected {
		t.Fatalf("dropped guest should show as reconnecting, roster %+v", r)
	}

	// Coming back with the token resumes the same participant.
	again, resumed := h.join("Guest", "", joined.ResumeToken)
	var back joinedPayload
	if !again.last(MsgJoined, &back) || !back.Resumed || back.Self.ID != joined.Self.ID {
		t.Fatalf("resume gave %+v", back)
	}
	time.Sleep(150 * time.Millisecond)
	if r := roster(t, hostConn); len(r) != 2 || !find(t, r, joined.Self.ID).Connected {
		t.Fatalf("resumed guest should be connected, roster %+v", r)
	}

	// A second resume from elsewhere replaces the first connection.
	third, _ := h.join("Guest", "", joined.ResumeToken)
	if closed, code := again.closeCode(); !closed || code != CloseReplaced {
		t.Fatalf("replaced connection: closed=%v code=%d", closed, code)
	}
	resumed.Closed() // the replaced connection's read loop ending changes nothing
	if !third.last(MsgJoined, nil) {
		t.Fatal("third connection did not get in")
	}

	h.reg.mu.Lock()
	m := h.reg.live[h.code]
	h.reg.mu.Unlock()
	m.mu.Lock()
	p := m.participants[joined.Self.ID]
	m.mu.Unlock()
	(&Session{m: m, p: p, conn: third}).Closed()
	time.Sleep(200 * time.Millisecond)
	if r := roster(t, hostConn); len(r) != 1 {
		t.Fatalf("guest should be gone after grace, roster %+v", r)
	}
	h.media.mu.Lock()
	defer h.media.mu.Unlock()
	if len(h.media.removed) != 1 || h.media.removed[0] != joined.Self.ID {
		t.Fatalf("media peers removed: %v", h.media.removed)
	}
}

func TestChatHistoryAndSettings(t *testing.T) {
	h := newHarness(t, time.Minute)
	hostConn, host := h.join("Host", h.key, "")
	guestConn, guest := h.join("Guest", "", "")

	send(guest, MsgChat, chatPayload{Text: "  hello there  "})
	var msg ChatMessage
	if !hostConn.last(MsgChat, &msg) || msg.Text != "hello there" || msg.Name != "Guest" {
		t.Fatalf("host got chat %+v", msg)
	}

	late, _ := h.join("Late", "", "")
	var joined joinedPayload
	late.last(MsgJoined, &joined)
	if len(joined.Chat) != 1 || joined.Chat[0].Text != "hello there" {
		t.Fatalf("late joiner chat history = %+v", joined.Chat)
	}

	send(host, MsgSettings, map[string]bool{"chat_enabled": false})
	var settings settingsPayload
	if !guestConn.last(MsgSettings, &settings) || settings.Settings.ChatEnabled {
		t.Fatalf("guest settings = %+v", settings)
	}
	send(guest, MsgChat, chatPayload{Text: "still here?"})
	var e errorPayload
	if !guestConn.last(MsgError, &e) || e.Code != "chat_disabled" {
		t.Fatalf("guest error = %+v", e)
	}
	send(host, MsgChat, chatPayload{Text: "hosts can still talk"})
	if guestConn.last(MsgChat, &msg); msg.Text != "hosts can still talk" {
		t.Fatalf("guest last chat = %+v", msg)
	}

	// Settings outlive the call.
	rec, _ := h.reg.store.Get(h.code)
	if rec.Settings.ChatEnabled {
		t.Fatal("chat setting was not persisted")
	}
}

func TestHostControls(t *testing.T) {
	h := newHarness(t, time.Minute)
	hostConn, host := h.join("Host", h.key, "")
	guestConn, guest := h.join("Guest", "", "")
	var joined joinedPayload
	guestConn.last(MsgJoined, &joined)
	guestID := joined.Self.ID

	send(guest, MsgMute, targetPayload{ParticipantID: guestID})
	var e errorPayload
	if !guestConn.last(MsgError, &e) || e.Code != "not_host" {
		t.Fatalf("guest muting got %+v", e)
	}

	send(guest, MsgHand, handPayload{Raised: true})
	if find(t, roster(t, hostConn), guestID).HandRaisedAt == 0 {
		t.Fatal("raised hand not shown")
	}
	send(host, MsgLowerHand, targetPayload{ParticipantID: guestID})
	if find(t, roster(t, hostConn), guestID).HandRaisedAt != 0 {
		t.Fatal("host could not lower the hand")
	}

	send(host, MsgMute, targetPayload{ParticipantID: guestID})
	if !guestConn.last(MsgForceMute, nil) {
		t.Fatal("guest was not told to mute")
	}
	if !find(t, roster(t, hostConn), guestID).AudioMuted {
		t.Fatal("muted guest not shown muted")
	}

	send(guest, MsgReaction, reactionPayload{Emoji: "🎉"})
	var reaction reactionPayload
	if !hostConn.last(MsgReaction, &reaction) || reaction.ParticipantID != guestID {
		t.Fatalf("reaction = %+v", reaction)
	}
	send(guest, MsgReaction, reactionPayload{Emoji: "<script>"})
	if hostConn.last(MsgReaction, &reaction); reaction.Emoji != "🎉" {
		t.Fatal("an arbitrary reaction was relayed")
	}

	send(host, MsgRemove, targetPayload{ParticipantID: guestID})
	if closed, code := guestConn.closeCode(); !closed || code != CloseRemoved {
		t.Fatalf("removed guest: closed=%v code=%d", closed, code)
	}
	if r := roster(t, hostConn); len(r) != 1 {
		t.Fatalf("roster after removal = %+v", r)
	}
}

func TestEndingAndEmptyingAMeeting(t *testing.T) {
	h := newHarness(t, time.Minute)
	hostConn, host := h.join("Host", h.key, "")
	guestConn, _ := h.join("Guest", "", "")

	send(host, MsgEndMeeting, nil)
	for _, c := range []*fakeConn{hostConn, guestConn} {
		if closed, code := c.closeCode(); !closed || code != CloseEnded || !c.last(MsgEnded, nil) {
			t.Fatalf("after end: closed=%v code=%d", closed, code)
		}
	}
	if s := h.reg.Stats(); s.LiveMeetings != 0 {
		t.Fatalf("live meetings after end = %d", s.LiveMeetings)
	}

	// The link still works afterwards, and the meeting shuts down when the last
	// person leaves.
	h.media = &fakeMedia{}
	conn, s := h.join("Again", "", "")
	if !conn.last(MsgJoined, nil) {
		t.Fatal("could not rejoin an ended meeting's link")
	}
	send(s, MsgLeave, nil)
	if closed, code := conn.closeCode(); !closed || code != CloseLeft {
		t.Fatalf("leave: closed=%v code=%d", closed, code)
	}
	h.media.mu.Lock()
	defer h.media.mu.Unlock()
	if !h.media.closed {
		t.Fatal("media room was not closed when the meeting emptied")
	}
}

func TestMeetingFull(t *testing.T) {
	h := newHarness(t, time.Minute)
	for range 4 {
		h.join("p", "", "")
	}
	if _, err := h.reg.Join(h.code, &fakeConn{}, JoinRequest{Name: "one too many"}); err != ErrFull {
		t.Fatalf("join over capacity: %v", err)
	}
	if _, err := h.reg.Join("zzz-zzzz-zzz", &fakeConn{}, JoinRequest{}); err != ErrNotFound {
		t.Fatalf("join unknown meeting: %v", err)
	}
}

func TestNormalizeCode(t *testing.T) {
	cases := map[string]string{
		"abc-defg-hjk":                          "abc-defg-hjk",
		"ABCDEFGHJK":                            "abc-defg-hjk",
		" abc defg hjk ":                        "abc-defg-hjk",
		"https://meet.example/abc-defg-hjk?x=1": "abc-defg-hjk",
	}
	for in, want := range cases {
		if got, ok := NormalizeCode(in); !ok || got != want {
			t.Errorf("NormalizeCode(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "abc", "abc-defg-hji", "abc-defg-hjkk", "abc-defg-hj1"} {
		if _, ok := NormalizeCode(bad); ok {
			t.Errorf("NormalizeCode(%q) accepted an invalid code", bad)
		}
	}
	for range 50 {
		if code := NewCode(); code != mustNormalize(t, code) {
			t.Fatalf("generated code %q does not round-trip", code)
		}
	}
}

func mustNormalize(t *testing.T, code string) string {
	t.Helper()
	got, ok := NormalizeCode(code)
	if !ok {
		t.Fatalf("NormalizeCode(%q) failed", code)
	}
	return got
}

func TestFileStoreSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "meetings.json")
	s, err := OpenFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	old := Record{Code: "aaa-aaaa-aaa", LastUsedAt: time.Now().Add(-48 * time.Hour)}
	fresh := Record{Code: "bbb-bbbb-bbb", LastUsedAt: time.Now(), Settings: Settings{Locked: true}}
	for _, r := range []Record{old, fresh} {
		if err := s.Put(r); err != nil {
			t.Fatal(err)
		}
	}
	reopened, err := OpenFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := reopened.Get("bbb-bbbb-bbb"); !ok || !got.Settings.Locked {
		t.Fatalf("reopened record = %+v, %v", got, ok)
	}
	if n, err := reopened.Prune(time.Now().Add(-24 * time.Hour)); err != nil || n != 1 {
		t.Fatalf("prune = %d, %v", n, err)
	}
	if _, ok := reopened.Get("aaa-aaaa-aaa"); ok {
		t.Fatal("stale record survived pruning")
	}
}

func TestHostKeyIsNotStoredInTheClear(t *testing.T) {
	h := newHarness(t, time.Minute)
	rec, _ := h.reg.store.Get(h.code)
	if rec.HostKeyHash == h.key || !secretMatches(h.key, rec.HostKeyHash) || secretMatches("", rec.HostKeyHash) {
		t.Fatal("host key hashing is broken")
	}
}
