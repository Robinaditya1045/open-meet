package meeting

import "encoding/json"

// Every message in either direction is {"type": ..., "data": ...}.
type envelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

type outEnvelope struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

// Client → server.
const (
	MsgJoin          = "join"
	MsgLeave         = "leave"
	MsgPing          = "ping"
	MsgOffer         = "offer"
	MsgAnswer        = "answer"
	MsgCandidate     = "candidate"
	MsgMediaState    = "media_state"
	MsgSubscriptions = "subscriptions"
	MsgChat          = "chat"
	MsgHand          = "hand"
	MsgReaction      = "reaction"

	// Host only.
	MsgMute       = "mute"
	MsgMuteAll    = "mute_all"
	MsgRemove     = "remove"
	MsgLowerHand  = "lower_hand"
	MsgAdmit      = "admit"
	MsgAdmitAll   = "admit_all"
	MsgDeny       = "deny"
	MsgMakeHost   = "make_host"
	MsgSettings   = "settings"
	MsgEndMeeting = "end_meeting"
)

// Server → client.
const (
	MsgJoined       = "joined"
	MsgWaiting      = "waiting"
	MsgDenied       = "denied"
	MsgParticipants = "participants"
	MsgLobby        = "lobby"
	MsgAudioLevels  = "audio_levels"
	MsgForceMute    = "force_mute"
	MsgRemoved      = "removed"
	MsgEnded        = "ended"
	MsgError        = "error"
	MsgPong         = "pong"
	// MsgOffer, MsgAnswer, MsgCandidate, MsgChat, MsgReaction and MsgSettings
	// are also sent by the server.
)

// WebSocket close codes. A client reconnects after anything else; after these it
// shows why it was disconnected instead.
const (
	CloseLeft     = 4000
	CloseRemoved  = 4001
	CloseDenied   = 4002
	CloseEnded    = 4003
	CloseNotFound = 4004
	CloseFull     = 4005
	CloseProtocol = 4008
	// CloseReplaced is sent to a connection whose session was resumed by another.
	CloseReplaced = 4009
)

// JoinRequest is the first message on every connection.
type JoinRequest struct {
	Name        string `json:"name"`
	HostKey     string `json:"host_key,omitempty"`
	ResumeToken string `json:"resume_token,omitempty"`
}

// ParticipantInfo is one row of the roster every client renders.
type ParticipantInfo struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	IsHost        bool   `json:"is_host"`
	AudioMuted    bool   `json:"audio_muted"`
	VideoOn       bool   `json:"video_on"`
	ScreenSharing bool   `json:"screen_sharing"`
	HandRaisedAt  int64  `json:"hand_raised_at"`
	JoinedAt      int64  `json:"joined_at"`
	// Connected is false while the participant's connection is down and the
	// server is holding their place for them to come back.
	Connected bool `json:"connected"`
}

// LobbyEntry is someone asking to join.
type LobbyEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	RequestedAt int64  `json:"requested_at"`
}

// MeetingInfo describes the meeting itself.
type MeetingInfo struct {
	Code      string   `json:"code"`
	CreatedAt int64    `json:"created_at"`
	Settings  Settings `json:"settings"`
}

// ICEServer is a STUN or TURN server handed to browsers.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// ChatMessage is one line of in-call chat.
type ChatMessage struct {
	ID            string `json:"id"`
	ParticipantID string `json:"participant_id"`
	Name          string `json:"name"`
	Text          string `json:"text"`
	SentAt        int64  `json:"sent_at"`
}

type joinedPayload struct {
	Self         ParticipantInfo   `json:"self"`
	ResumeToken  string            `json:"resume_token"`
	Resumed      bool              `json:"resumed"`
	Meeting      MeetingInfo       `json:"meeting"`
	Participants []ParticipantInfo `json:"participants"`
	Chat         []ChatMessage     `json:"chat"`
	Lobby        []LobbyEntry      `json:"lobby"`
	ICEServers   []ICEServer       `json:"ice_servers"`
}

type waitingPayload struct {
	ResumeToken string `json:"resume_token"`
	Name        string `json:"name"`
}

type reasonPayload struct {
	Reason string `json:"reason"`
	By     string `json:"by,omitempty"`
}

type participantsPayload struct {
	Participants []ParticipantInfo `json:"participants"`
}

type lobbyPayload struct {
	Lobby []LobbyEntry `json:"lobby"`
}

type sdpPayload struct {
	SDP string `json:"sdp"`
	// Streams declares what each stream the browser publishes is ("mic",
	// "camera" or "screen"), keyed by MediaStream ID.
	Streams map[string]string `json:"streams,omitempty"`
	// Restart marks the first offer of a brand-new RTCPeerConnection.
	Restart bool `json:"restart,omitempty"`
}

type candidatePayload struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdp_mid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdp_mline_index,omitempty"`
	UsernameFragment *string `json:"username_fragment,omitempty"`
}

type mediaStatePayload struct {
	AudioMuted    bool `json:"audio_muted"`
	VideoOn       bool `json:"video_on"`
	ScreenSharing bool `json:"screen_sharing"`
}

type subscriptionsPayload struct {
	// Qualities maps a track name ("camera.<id>") to "off", "low", "medium" or "high".
	Qualities map[string]string `json:"qualities"`
}

type chatPayload struct {
	Text string `json:"text"`
}

type handPayload struct {
	Raised bool `json:"raised"`
}

type reactionPayload struct {
	ParticipantID string `json:"participant_id,omitempty"`
	Emoji         string `json:"emoji"`
}

type targetPayload struct {
	ParticipantID string `json:"participant_id"`
}

type settingsPatch struct {
	Locked             *bool `json:"locked,omitempty"`
	ChatEnabled        *bool `json:"chat_enabled,omitempty"`
	ScreenShareEnabled *bool `json:"screen_share_enabled,omitempty"`
	ReactionsEnabled   *bool `json:"reactions_enabled,omitempty"`
}

type settingsPayload struct {
	Settings Settings `json:"settings"`
}

type audioLevelsPayload struct {
	Levels   map[string]float64 `json:"levels"`
	Dominant string             `json:"dominant,omitempty"`
}

type errorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// encode marshals an outgoing message once, so a broadcast to forty people costs
// one marshal rather than forty.
func encode(msgType string, data any) []byte {
	b, err := json.Marshal(outEnvelope{Type: msgType, Data: data})
	if err != nil {
		panic(err)
	}
	return b
}

// ParseMessage splits an incoming frame into its type and payload.
func ParseMessage(raw []byte) (string, json.RawMessage, error) {
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return "", nil, err
	}
	return env.Type, env.Data, nil
}

// ParseJoin reads the payload of a join message.
func ParseJoin(data json.RawMessage) (JoinRequest, error) {
	var req JoinRequest
	if len(data) == 0 {
		return req, nil
	}
	err := json.Unmarshal(data, &req)
	return req, err
}

// DeniedMessage tells a connection why it was turned away before it joined.
func DeniedMessage(reason string) []byte {
	return encode(MsgDenied, reasonPayload{Reason: reason})
}
