import { create } from 'zustand'
import type { ChatMessage, LobbyEntry, Participant, Settings } from '../lib/protocol'
import type { SocketStatus } from '../lib/signaling'

/**
 * Where this tab is in the meeting. Everything after 'joined' is terminal and
 * picks the screen shown instead of the call.
 */
export type Phase =
  | 'connecting'
  | 'waiting'
  | 'joined'
  | 'left'
  | 'removed'
  | 'denied'
  | 'ended'
  | 'not_found'
  | 'full'
  | 'replaced'
  | 'lost'

export type Panel = 'info' | 'people' | 'chat' | 'host' | null

export type NetworkQuality = 'good' | 'fair' | 'poor' | 'unknown'

export interface LocalMedia {
  micTrack: MediaStreamTrack | null
  cameraTrack: MediaStreamTrack | null
  screenTrack: MediaStreamTrack | null
  micOn: boolean
  cameraOn: boolean
  sharing: boolean
}

export interface Reaction {
  id: number
  participantId: string
  name: string
  emoji: string
  /** Horizontal start position, 0..1, so a burst doesn't stack on one line. */
  lane: number
}

export interface MeetingState {
  code: string
  phase: Phase
  /** Who ended the call or removed this participant, for the goodbye screen. */
  phaseBy: string | null
  socket: SocketStatus
  media: RTCPeerConnectionState
  network: NetworkQuality
  selfId: string | null
  participants: Participant[]
  settings: Settings
  createdAt: number
  chat: ChatMessage[]
  unread: number
  lobby: LobbyEntry[]
  /** Forwarded tracks by SFU track name ("camera.<id>"). */
  remote: Record<string, MediaStreamTrack>
  local: LocalMedia
  dominant: string | null
  /** Recent dominant speakers, most recent first; they keep a tile in a crowded grid. */
  recentSpeakers: string[]
  panel: Panel
  pinned: string | null
  reactions: Reaction[]
  speakerId: string | null
}

export const defaultSettings: Settings = {
  locked: false,
  chat_enabled: true,
  screen_share_enabled: true,
  reactions_enabled: true,
}

export function initialMeetingState(code: string): MeetingState {
  return {
    code,
    phase: 'connecting',
    phaseBy: null,
    socket: 'connecting',
    media: 'new',
    network: 'unknown',
    selfId: null,
    participants: [],
    settings: defaultSettings,
    createdAt: Date.now(),
    chat: [],
    unread: 0,
    lobby: [],
    remote: {},
    local: { micTrack: null, cameraTrack: null, screenTrack: null, micOn: false, cameraOn: false, sharing: false },
    dominant: null,
    recentSpeakers: [],
    panel: null,
    pinned: null,
    reactions: [],
    speakerId: null,
  }
}

export const useMeeting = create<MeetingState>(() => initialMeetingState(''))

/**
 * Audio levels arrive five times a second. They live apart from the meeting so
 * that only the tiles that show a level re-render on each update.
 */
export const useLevels = create<{ levels: Record<string, number> }>(() => ({ levels: {} }))

export function selfParticipant(s: MeetingState): Participant | undefined {
  return s.participants.find((p) => p.id === s.selfId)
}

export function isHost(s: MeetingState): boolean {
  return selfParticipant(s)?.is_host ?? false
}
