package meeting

import (
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Robinaditya1045/open-meet/server/internal/sfu"
	"github.com/pion/webrtc/v4"
	"golang.org/x/time/rate"
)

const (
	maxNameLength    = 60
	maxChatLength    = 2000
	maxChatHistory   = 500
	maxSubscriptions = 300
)

// allowedReactions is the set the client offers. Anything else is dropped rather
// than relayed, so a reaction can never be an arbitrary string on everyone's screen.
var allowedReactions = map[string]bool{
	"💖": true, "👍": true, "🎉": true, "👏": true, "😂": true,
	"😮": true, "😢": true, "🤔": true, "👎": true,
}

// Conn is one client connection. Send must not block: a client too slow to keep
// up is disconnected rather than allowed to stall the meeting.
type Conn interface {
	Send(msg []byte) bool
	Close(code int, reason string)
}

// Participant is one person in a meeting, or asking to join it.
type Participant struct {
	id          string
	name        string
	host        bool
	resumeToken string
	requestedAt int64
	joinedAt    int64

	audioMuted    bool
	videoOn       bool
	screenSharing bool
	handRaisedAt  int64

	admitted bool
	gone     bool
	grace    *time.Timer

	chatLimit     *rate.Limiter
	reactionLimit *rate.Limiter

	// conn is guarded by its own lock so the SFU can reach a participant
	// without taking the meeting's.
	connMu sync.Mutex
	conn   Conn
}

func (p *Participant) send(msg []byte) {
	if c := p.currentConn(); c != nil {
		c.Send(msg)
	}
}

func (p *Participant) currentConn() Conn {
	p.connMu.Lock()
	defer p.connMu.Unlock()
	return p.conn
}

func (p *Participant) setConn(c Conn) Conn {
	p.connMu.Lock()
	defer p.connMu.Unlock()
	old := p.conn
	p.conn = c
	return old
}

// Meeting is the live state of a meeting someone is in.
//
// Lock order: Registry.mu, then Meeting.mu, then Participant.connMu. The SFU calls
// in from under its own locks, so the meeting never calls the SFU while holding
// mu; every media call happens after the state change it follows is committed.
type Meeting struct {
	code string
	reg  *Registry

	mu           sync.Mutex
	rec          Record
	participants map[string]*Participant
	waiting      map[string]*Participant
	chat         []ChatMessage
	media        MediaRoom
	closed       bool
}

func newMeeting(reg *Registry, rec Record) *Meeting {
	return &Meeting{
		code:         rec.Code,
		reg:          reg,
		rec:          rec,
		participants: map[string]*Participant{},
		waiting:      map[string]*Participant{},
	}
}

func (m *Meeting) now() int64 { return m.reg.opts.Now().UnixMilli() }

// Session ties one connection to the participant it joined as.
type Session struct {
	m    *Meeting
	p    *Participant
	conn Conn
}

// ParticipantID reports who the session joined as.
func (s *Session) ParticipantID() string { return s.p.id }

// Join admits a connection to the meeting, puts it in the lobby, or — given the
// token of a participant whose connection dropped — hands it their place back.
func (m *Meeting) Join(conn Conn, req JoinRequest) (*Session, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errGone
	}

	if req.ResumeToken != "" {
		if p := m.byResumeToken(req.ResumeToken); p != nil {
			old := p.setConn(conn)
			if p.grace != nil {
				p.grace.Stop()
				p.grace = nil
			}
			var media MediaRoom
			if p.admitted {
				p.send(m.joinedLocked(p, true))
				m.broadcastRosterLocked(p.id)
				media = m.media
			} else {
				p.send(encode(MsgWaiting, waitingPayload{ResumeToken: p.resumeToken, Name: p.name}))
			}
			m.mu.Unlock()
			if old != nil && old != conn {
				old.Close(CloseReplaced, "this session continued in another window")
			}
			if media != nil {
				media.Resync(p.id)
			}
			slog.Info("participant resumed", "meeting", m.code, "participant", p.id)
			return &Session{m: m, p: p, conn: conn}, nil
		}
	}

	if len(m.participants)+len(m.waiting) >= m.reg.opts.MaxParticipants {
		m.mu.Unlock()
		return nil, ErrFull
	}

	p := &Participant{
		id:            newParticipantID(),
		name:          cleanName(req.Name),
		host:          secretMatches(req.HostKey, m.rec.HostKeyHash),
		resumeToken:   newSecret(),
		requestedAt:   m.now(),
		chatLimit:     rate.NewLimiter(1, 5),
		reactionLimit: rate.NewLimiter(3, 10),
	}
	p.setConn(conn)
	s := &Session{m: m, p: p, conn: conn}

	if !p.host && m.rec.Settings.Locked {
		m.waiting[p.id] = p
		p.send(encode(MsgWaiting, waitingPayload{ResumeToken: p.resumeToken, Name: p.name}))
		m.sendLobbyLocked()
		m.mu.Unlock()
		slog.Info("participant asked to join", "meeting", m.code, "participant", p.id)
		return s, nil
	}
	m.admitLocked(p)
	m.mu.Unlock()
	slog.Info("participant joined", "meeting", m.code, "participant", p.id, "host", p.host)
	return s, nil
}

func (m *Meeting) byResumeToken(token string) *Participant {
	for _, p := range m.participants {
		if p.resumeToken == token {
			return p
		}
	}
	for _, p := range m.waiting {
		if p.resumeToken == token {
			return p
		}
	}
	return nil
}

func (m *Meeting) admitLocked(p *Participant) {
	delete(m.waiting, p.id)
	p.admitted = true
	p.joinedAt = m.now()
	m.participants[p.id] = p
	if m.media == nil && m.reg.media != nil {
		m.media = m.reg.media(m.code, m)
	}
	p.send(m.joinedLocked(p, false))
	m.broadcastRosterLocked(p.id)
}

func (m *Meeting) joinedLocked(p *Participant, resumed bool) []byte {
	lobby := []LobbyEntry{}
	if p.host {
		lobby = m.lobbyLocked()
	}
	chat := make([]ChatMessage, len(m.chat))
	copy(chat, m.chat)
	return encode(MsgJoined, joinedPayload{
		Self:         m.infoLocked(p),
		ResumeToken:  p.resumeToken,
		Resumed:      resumed,
		Meeting:      MeetingInfo{Code: m.code, CreatedAt: m.rec.CreatedAt.UnixMilli(), Settings: m.rec.Settings},
		Participants: m.rosterLocked(),
		Chat:         chat,
		Lobby:        lobby,
		ICEServers:   m.reg.opts.ICEServers,
	})
}

func (m *Meeting) infoLocked(p *Participant) ParticipantInfo {
	return ParticipantInfo{
		ID:            p.id,
		Name:          p.name,
		IsHost:        p.host,
		AudioMuted:    p.audioMuted,
		VideoOn:       p.videoOn,
		ScreenSharing: p.screenSharing,
		HandRaisedAt:  p.handRaisedAt,
		JoinedAt:      p.joinedAt,
		Connected:     p.currentConn() != nil,
	}
}

func (m *Meeting) rosterLocked() []ParticipantInfo {
	roster := make([]ParticipantInfo, 0, len(m.participants))
	for _, p := range m.participants {
		roster = append(roster, m.infoLocked(p))
	}
	sort.Slice(roster, func(i, j int) bool {
		if roster[i].JoinedAt != roster[j].JoinedAt {
			return roster[i].JoinedAt < roster[j].JoinedAt
		}
		return roster[i].ID < roster[j].ID
	})
	return roster
}

func (m *Meeting) lobbyLocked() []LobbyEntry {
	lobby := make([]LobbyEntry, 0, len(m.waiting))
	for _, p := range m.waiting {
		lobby = append(lobby, LobbyEntry{ID: p.id, Name: p.name, RequestedAt: p.requestedAt})
	}
	sort.Slice(lobby, func(i, j int) bool { return lobby[i].RequestedAt < lobby[j].RequestedAt })
	return lobby
}

// broadcastRosterLocked sends the whole roster to everyone except skip, who
// already has it. Clients replace their roster wholesale, which keeps them correct
// however many updates they missed while reconnecting.
func (m *Meeting) broadcastRosterLocked(skip string) {
	msg := encode(MsgParticipants, participantsPayload{Participants: m.rosterLocked()})
	for id, p := range m.participants {
		if id != skip {
			p.send(msg)
		}
	}
}

func (m *Meeting) broadcastLocked(msg []byte) {
	for _, p := range m.participants {
		p.send(msg)
	}
}

func (m *Meeting) sendLobbyLocked() {
	msg := encode(MsgLobby, lobbyPayload{Lobby: m.lobbyLocked()})
	for _, p := range m.participants {
		if p.host {
			p.send(msg)
		}
	}
}

func (m *Meeting) emptyLocked() bool {
	return len(m.participants) == 0 && len(m.waiting) == 0
}

// removeLocked takes a participant out of the meeting. The caller finishes the
// job with afterRemoval once the lock is released.
func (m *Meeting) removeLocked(p *Participant) (MediaRoom, bool) {
	wasWaiting := !p.admitted
	delete(m.participants, p.id)
	delete(m.waiting, p.id)
	p.gone = true
	if p.grace != nil {
		p.grace.Stop()
		p.grace = nil
	}
	if wasWaiting {
		m.sendLobbyLocked()
		return nil, m.emptyLocked()
	}
	m.broadcastRosterLocked("")
	return m.media, m.emptyLocked()
}

func (m *Meeting) afterRemoval(p *Participant, media MediaRoom, empty bool) {
	if media != nil {
		media.RemovePeer(p.id)
	}
	if empty {
		m.reg.release(m)
	}
	slog.Info("participant left", "meeting", m.code, "participant", p.id)
}

// shutDownIfEmpty marks an empty meeting closed and hands back its media room
// for the caller to close. Called with the registry lock held.
func (m *Meeting) shutDownIfEmpty() (MediaRoom, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.emptyLocked() {
		return nil, false
	}
	m.closed = true
	media := m.media
	m.media = nil
	return media, true
}

func (m *Meeting) summary() (count int, names []string, locked bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	roster := m.rosterLocked()
	names = []string{}
	for _, p := range roster {
		if len(names) == 4 {
			break
		}
		names = append(names, p.Name)
	}
	return len(roster), names, m.rec.Settings.Locked
}

// takeEveryone empties the meeting and marks it closed, for ending or shutting it down.
func (m *Meeting) takeEveryone() ([]*Participant, MediaRoom) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, nil
	}
	m.closed = true
	everyone := make([]*Participant, 0, len(m.participants)+len(m.waiting))
	for _, group := range []map[string]*Participant{m.participants, m.waiting} {
		for _, p := range group {
			p.gone = true
			if p.grace != nil {
				p.grace.Stop()
				p.grace = nil
			}
			everyone = append(everyone, p)
		}
	}
	m.participants = map[string]*Participant{}
	m.waiting = map[string]*Participant{}
	m.chat = nil
	media := m.media
	m.media = nil
	return everyone, media
}

// end closes the meeting for everyone.
func (m *Meeting) end(by string) {
	everyone, media := m.takeEveryone()
	msg := encode(MsgEnded, reasonPayload{Reason: "ended", By: by})
	for _, p := range everyone {
		if c := p.currentConn(); c != nil {
			c.Send(msg)
			c.Close(CloseEnded, "the meeting was ended")
		}
	}
	m.reg.forget(m)
	if media != nil {
		media.Close()
	}
	slog.Info("meeting ended", "meeting", m.code, "by", by)
}

// shutdown disconnects everyone with "service restart", which clients answer by
// reconnecting.
func (m *Meeting) shutdown() {
	everyone, media := m.takeEveryone()
	for _, p := range everyone {
		if c := p.currentConn(); c != nil {
			c.Close(1012, "server restarting")
		}
	}
	if media != nil {
		media.Close()
	}
}

func (m *Meeting) expire(p *Participant) {
	m.mu.Lock()
	if p.gone || p.currentConn() != nil {
		m.mu.Unlock()
		return
	}
	media, empty := m.removeLocked(p)
	m.mu.Unlock()
	m.afterRemoval(p, media, empty)
}

// sendTo delivers a message to one admitted participant.
func (m *Meeting) sendTo(id string, msg []byte) {
	m.mu.Lock()
	p := m.participants[id]
	m.mu.Unlock()
	if p != nil {
		p.send(msg)
	}
}

// SendDescription implements sfu.Signaler.
func (m *Meeting) SendDescription(peerID string, sd webrtc.SessionDescription) {
	msgType := MsgOffer
	if sd.Type == webrtc.SDPTypeAnswer {
		msgType = MsgAnswer
	}
	m.sendTo(peerID, encode(msgType, sdpPayload{SDP: sd.SDP}))
}

// SendCandidate implements sfu.Signaler.
func (m *Meeting) SendCandidate(peerID string, c webrtc.ICECandidateInit) {
	m.sendTo(peerID, encode(MsgCandidate, candidatePayload{
		Candidate:        c.Candidate,
		SDPMid:           c.SDPMid,
		SDPMLineIndex:    c.SDPMLineIndex,
		UsernameFragment: c.UsernameFragment,
	}))
}

// SendAudioLevels implements sfu.Signaler.
func (m *Meeting) SendAudioLevels(levels map[string]float64, dominant string) {
	msg := encode(MsgAudioLevels, audioLevelsPayload{Levels: levels, Dominant: dominant})
	m.mu.Lock()
	defer m.mu.Unlock()
	m.broadcastLocked(msg)
}

// Closed is called when the session's connection is gone. Someone who was in the
// call keeps their place for the reconnect grace period; someone still in the
// lobby simply leaves it.
func (s *Session) Closed() {
	m, p := s.m, s.p
	m.mu.Lock()
	if p.currentConn() != s.conn {
		m.mu.Unlock()
		return
	}
	p.setConn(nil)
	if p.gone {
		m.mu.Unlock()
		return
	}
	if !p.admitted {
		media, empty := m.removeLocked(p)
		m.mu.Unlock()
		m.afterRemoval(p, media, empty)
		return
	}
	p.grace = time.AfterFunc(m.reg.opts.ReconnectGrace, func() { m.expire(p) })
	m.broadcastRosterLocked("")
	m.mu.Unlock()
}

// Handle dispatches one message from the session's connection.
func (s *Session) Handle(msgType string, data json.RawMessage) {
	m, p := s.m, s.p

	m.mu.Lock()
	stale := p.gone || p.currentConn() != s.conn
	admitted := p.admitted
	host := p.host
	media := m.media
	m.mu.Unlock()
	if stale {
		return
	}

	switch msgType {
	case MsgPing:
		s.conn.Send(encode(MsgPong, nil))
		return
	case MsgLeave:
		m.leave(p, s.conn)
		return
	}
	if !admitted {
		return
	}

	switch msgType {
	case MsgOffer:
		var pl sdpPayload
		if !s.decode(data, &pl) || media == nil {
			return
		}
		if err := media.HandleOffer(p.id, pl.SDP, pl.Streams, pl.Restart); err != nil && !errors.Is(err, sfu.ErrOfferCollision) {
			slog.Warn("could not answer offer", "meeting", m.code, "participant", p.id, "error", err)
			s.sendError("negotiation_failed", "The media connection could not be set up.")
		}
	case MsgAnswer:
		var pl sdpPayload
		if !s.decode(data, &pl) || media == nil {
			return
		}
		if err := media.HandleAnswer(p.id, pl.SDP, pl.Streams); err != nil {
			slog.Warn("could not apply answer", "meeting", m.code, "participant", p.id, "error", err)
			s.sendError("negotiation_failed", "The media connection could not be set up.")
		}
	case MsgCandidate:
		var pl candidatePayload
		if !s.decode(data, &pl) || media == nil {
			return
		}
		_ = media.AddCandidate(p.id, webrtc.ICECandidateInit{
			Candidate:        pl.Candidate,
			SDPMid:           pl.SDPMid,
			SDPMLineIndex:    pl.SDPMLineIndex,
			UsernameFragment: pl.UsernameFragment,
		})
	case MsgSubscriptions:
		var pl subscriptionsPayload
		if !s.decode(data, &pl) || media == nil || len(pl.Qualities) > maxSubscriptions {
			return
		}
		prefs := make(map[string]sfu.Quality, len(pl.Qualities))
		for name, raw := range pl.Qualities {
			q, ok := sfu.ParseQuality(raw)
			if _, _, valid := sfu.SplitTrackName(name); ok && valid {
				prefs[name] = q
			}
		}
		media.SetPreferences(p.id, prefs)
	case MsgMediaState:
		var pl mediaStatePayload
		if s.decode(data, &pl) {
			m.setMediaState(s, pl)
		}
	case MsgChat:
		var pl chatPayload
		if s.decode(data, &pl) {
			m.sendChat(s, pl.Text)
		}
	case MsgHand:
		var pl handPayload
		if s.decode(data, &pl) {
			m.setHand(p, pl.Raised)
		}
	case MsgReaction:
		var pl reactionPayload
		if s.decode(data, &pl) {
			m.react(s, pl.Emoji)
		}
	case MsgMute, MsgMuteAll, MsgRemove, MsgLowerHand, MsgAdmit, MsgAdmitAll, MsgDeny, MsgMakeHost, MsgSettings, MsgEndMeeting:
		if !host {
			s.sendError("not_host", "Only hosts can do that.")
			return
		}
		s.handleHost(msgType, data)
	default:
		s.sendError("unknown_message", "Unknown message type "+msgType+".")
	}
}

func (s *Session) decode(data json.RawMessage, v any) bool {
	if len(data) == 0 {
		data = json.RawMessage("{}")
	}
	if err := json.Unmarshal(data, v); err != nil {
		s.sendError("bad_message", "Malformed message.")
		return false
	}
	return true
}

func (s *Session) sendError(code, message string) {
	s.conn.Send(encode(MsgError, errorPayload{Code: code, Message: message}))
}

func (m *Meeting) leave(p *Participant, conn Conn) {
	m.mu.Lock()
	if p.gone {
		m.mu.Unlock()
		return
	}
	media, empty := m.removeLocked(p)
	m.mu.Unlock()
	conn.Close(CloseLeft, "left the meeting")
	m.afterRemoval(p, media, empty)
}

func (m *Meeting) setMediaState(s *Session, pl mediaStatePayload) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := s.p
	if pl.ScreenSharing && !p.host && !m.rec.Settings.ScreenShareEnabled {
		pl.ScreenSharing = false
		s.sendError("screen_share_disabled", "The host has turned off screen sharing.")
	}
	if p.audioMuted == pl.AudioMuted && p.videoOn == pl.VideoOn && p.screenSharing == pl.ScreenSharing {
		return
	}
	p.audioMuted, p.videoOn, p.screenSharing = pl.AudioMuted, pl.VideoOn, pl.ScreenSharing
	m.broadcastRosterLocked("")
}

func (m *Meeting) sendChat(s *Session, text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if utf8.RuneCountInString(text) > maxChatLength {
		s.sendError("chat_too_long", "That message is too long.")
		return
	}
	if !s.p.chatLimit.Allow() {
		s.sendError("rate_limited", "You're sending messages too quickly.")
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if !s.p.host && !m.rec.Settings.ChatEnabled {
		s.sendError("chat_disabled", "The host has turned off chat.")
		return
	}
	msg := ChatMessage{
		ID:            newParticipantID(),
		ParticipantID: s.p.id,
		Name:          s.p.name,
		Text:          text,
		SentAt:        m.now(),
	}
	m.chat = append(m.chat, msg)
	if len(m.chat) > maxChatHistory {
		m.chat = append([]ChatMessage(nil), m.chat[len(m.chat)-maxChatHistory:]...)
	}
	m.broadcastLocked(encode(MsgChat, msg))
}

func (m *Meeting) setHand(p *Participant, raised bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if raised == (p.handRaisedAt != 0) {
		return
	}
	p.handRaisedAt = 0
	if raised {
		p.handRaisedAt = m.now()
	}
	m.broadcastRosterLocked("")
}

func (m *Meeting) react(s *Session, emoji string) {
	if !allowedReactions[emoji] || !s.p.reactionLimit.Allow() {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !s.p.host && !m.rec.Settings.ReactionsEnabled {
		return
	}
	m.broadcastLocked(encode(MsgReaction, reactionPayload{ParticipantID: s.p.id, Emoji: emoji}))
}

func (s *Session) handleHost(msgType string, data json.RawMessage) {
	m, host := s.m, s.p

	switch msgType {
	case MsgEndMeeting:
		m.end(host.name)
		return
	case MsgSettings:
		var patch settingsPatch
		if s.decode(data, &patch) {
			m.applySettings(patch)
		}
		return
	case MsgMuteAll:
		m.mu.Lock()
		msg := encode(MsgForceMute, reasonPayload{Reason: "muted_by_host", By: host.name})
		changed := false
		for _, p := range m.participants {
			if !p.host && !p.audioMuted {
				p.audioMuted = true
				p.send(msg)
				changed = true
			}
		}
		if changed {
			m.broadcastRosterLocked("")
		}
		m.mu.Unlock()
		return
	case MsgAdmitAll:
		m.mu.Lock()
		for _, p := range m.lobbyLocked() {
			if w := m.waiting[p.ID]; w != nil {
				m.admitLocked(w)
			}
		}
		m.sendLobbyLocked()
		m.mu.Unlock()
		return
	}

	var target targetPayload
	if !s.decode(data, &target) {
		return
	}

	m.mu.Lock()
	p := m.participants[target.ParticipantID]
	if p == nil {
		p = m.waiting[target.ParticipantID]
	}
	if p == nil {
		m.mu.Unlock()
		return
	}

	switch msgType {
	case MsgMute:
		if p.admitted && !p.audioMuted {
			p.audioMuted = true
			p.send(encode(MsgForceMute, reasonPayload{Reason: "muted_by_host", By: host.name}))
			m.broadcastRosterLocked("")
		}
		m.mu.Unlock()
	case MsgLowerHand:
		if p.handRaisedAt != 0 {
			p.handRaisedAt = 0
			m.broadcastRosterLocked("")
		}
		m.mu.Unlock()
	case MsgMakeHost:
		if p.admitted && !p.host {
			p.host = true
			m.broadcastRosterLocked("")
			if len(m.waiting) > 0 {
				p.send(encode(MsgLobby, lobbyPayload{Lobby: m.lobbyLocked()}))
			}
		}
		m.mu.Unlock()
	case MsgAdmit:
		if !p.admitted {
			m.admitLocked(p)
			m.sendLobbyLocked()
		}
		m.mu.Unlock()
	case MsgDeny, MsgRemove:
		if p == host {
			m.mu.Unlock()
			return
		}
		reason, code := "removed", CloseRemoved
		if !p.admitted {
			reason, code = "denied", CloseDenied
		}
		conn := p.currentConn()
		if conn != nil {
			conn.Send(encode(MsgRemoved, reasonPayload{Reason: reason, By: host.name}))
		}
		media, empty := m.removeLocked(p)
		m.mu.Unlock()
		if conn != nil {
			conn.Close(code, reason)
		}
		m.afterRemoval(p, media, empty)
	default:
		m.mu.Unlock()
	}
}

func (m *Meeting) applySettings(patch settingsPatch) {
	m.mu.Lock()
	s := m.rec.Settings
	if patch.Locked != nil {
		s.Locked = *patch.Locked
	}
	if patch.ChatEnabled != nil {
		s.ChatEnabled = *patch.ChatEnabled
	}
	if patch.ScreenShareEnabled != nil {
		s.ScreenShareEnabled = *patch.ScreenShareEnabled
	}
	if patch.ReactionsEnabled != nil {
		s.ReactionsEnabled = *patch.ReactionsEnabled
	}
	if s == m.rec.Settings {
		m.mu.Unlock()
		return
	}
	unlocked := m.rec.Settings.Locked && !s.Locked
	m.rec.Settings = s

	// Turning presenting off for guests stops their shares as far as everyone
	// else is concerned; their own client stops the capture when it sees this.
	if !s.ScreenShareEnabled {
		for _, p := range m.participants {
			if !p.host {
				p.screenSharing = false
			}
		}
	}
	m.broadcastLocked(encode(MsgSettings, settingsPayload{Settings: s}))
	// Opening a locked meeting lets in everyone who was waiting for it.
	if unlocked {
		for _, entry := range m.lobbyLocked() {
			if w := m.waiting[entry.ID]; w != nil {
				m.admitLocked(w)
			}
		}
		m.sendLobbyLocked()
	}
	m.broadcastRosterLocked("")
	m.mu.Unlock()

	m.reg.saveSettings(m.code, s)
}

// cleanName trims a display name to something safe to show everyone.
func cleanName(raw string) string {
	name := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '​' || r == '‮' {
			return -1
		}
		return r
	}, raw)
	name = strings.Join(strings.Fields(name), " ")
	if utf8.RuneCountInString(name) > maxNameLength {
		name = string([]rune(name)[:maxNameLength])
	}
	if name == "" {
		name = "Guest"
	}
	return name
}
