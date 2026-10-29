// Wire types for the signaling socket. These mirror server/internal/meeting/protocol.go;
// change both together.

export type MediaKind = 'mic' | 'camera' | 'screen'
export type Quality = 'off' | 'low' | 'medium' | 'high'

export interface Participant {
  id: string
  name: string
  is_host: boolean
  audio_muted: boolean
  video_on: boolean
  screen_sharing: boolean
  /** Milliseconds since the epoch, or 0 when the hand is down. */
  hand_raised_at: number
  joined_at: number
  /** False while the server is holding this participant's place through a reconnect. */
  connected: boolean
}

export interface LobbyEntry {
  id: string
  name: string
  requested_at: number
}

export interface Settings {
  locked: boolean
  chat_enabled: boolean
  screen_share_enabled: boolean
  reactions_enabled: boolean
}

export interface MeetingInfo {
  code: string
  created_at: number
  settings: Settings
}

export interface ChatMessage {
  id: string
  participant_id: string
  name: string
  text: string
  sent_at: number
}

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface JoinedPayload {
  self: Participant
  resume_token: string
  resumed: boolean
  meeting: MeetingInfo
  participants: Participant[]
  chat: ChatMessage[]
  lobby: LobbyEntry[]
  ice_servers: IceServer[]
}

export interface SdpPayload {
  sdp: string
  streams?: Record<string, MediaKind>
  restart?: boolean
}

export interface CandidatePayload {
  candidate: string
  sdp_mid?: string | null
  sdp_mline_index?: number | null
  username_fragment?: string | null
}

export interface ReasonPayload {
  reason: string
  by?: string
}

export interface ServerMessages {
  joined: JoinedPayload
  waiting: { resume_token: string; name: string }
  denied: ReasonPayload
  participants: { participants: Participant[] }
  lobby: { lobby: LobbyEntry[] }
  offer: SdpPayload
  answer: SdpPayload
  candidate: CandidatePayload
  chat: ChatMessage
  reaction: { participant_id: string; emoji: string }
  audio_levels: { levels: Record<string, number>; dominant?: string }
  force_mute: ReasonPayload
  removed: ReasonPayload
  ended: ReasonPayload
  settings: { settings: Settings }
  error: { code: string; message: string }
  pong: undefined
}

export interface ClientMessages {
  join: { name: string; host_key?: string; resume_token?: string }
  leave: undefined
  ping: undefined
  offer: SdpPayload
  answer: SdpPayload
  candidate: CandidatePayload
  media_state: { audio_muted: boolean; video_on: boolean; screen_sharing: boolean }
  subscriptions: { qualities: Record<string, Quality> }
  chat: { text: string }
  hand: { raised: boolean }
  reaction: { emoji: string }
  mute: { participant_id: string }
  mute_all: undefined
  remove: { participant_id: string }
  lower_hand: { participant_id: string }
  admit: { participant_id: string }
  admit_all: undefined
  deny: { participant_id: string }
  make_host: { participant_id: string }
  settings: Partial<Settings>
  end_meeting: undefined
}

/** Close codes after which a client shows why instead of reconnecting. */
export const CloseCode = {
  Left: 4000,
  Removed: 4001,
  Denied: 4002,
  Ended: 4003,
  NotFound: 4004,
  Full: 4005,
  Protocol: 4008,
  Replaced: 4009,
} as const

export const REACTIONS = ['💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔', '👎'] as const

/** "camera.<participantId>" — the SFU's name for a forwarded track. */
export function trackName(kind: MediaKind, participantId: string): string {
  return `${kind}.${participantId}`
}

export function parseTrackName(name: string): { kind: MediaKind; participantId: string } | null {
  const dot = name.indexOf('.')
  if (dot <= 0) return null
  const kind = name.slice(0, dot)
  const participantId = name.slice(dot + 1)
  if (!participantId) return null
  if (kind !== 'mic' && kind !== 'camera' && kind !== 'screen') return null
  return { kind, participantId }
}
