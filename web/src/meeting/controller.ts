import { socketUrl } from '../lib/api'
import {
  CloseCode,
  type ClientMessages,
  type JoinedPayload,
  type LobbyEntry,
  type Participant,
  type Quality,
  type ServerMessages,
  type Settings,
} from '../lib/protocol'
import { Signaling } from '../lib/signaling'
import { watchLevel } from '../lib/rtc/audioLevel'
import { describeMediaError, getCamera, getMicrophone, getScreen } from '../lib/rtc/devices'
import { RtcSession } from '../lib/rtc/session'
import { storage } from '../lib/storage'
import { initialMeetingState, useLevels, useMeeting, type MeetingState, type NetworkQuality, type Phase } from '../state/meeting'
import { dismissToastKey, toast } from '../state/toast'

export interface JoinOptions {
  code: string
  name: string
  hostKey: string | null
  /** Tracks opened in the green room, handed over so nobody is asked twice. */
  micTrack: MediaStreamTrack | null
  cameraTrack: MediaStreamTrack | null
  micOn: boolean
  cameraOn: boolean
}

const SUBSCRIPTION_DEBOUNCE_MS = 120
/** A connection that stays failed this long is rebuilt rather than restarted. */
const MEDIA_REBUILD_MS = 8_000
const REACTION_LIFETIME_MS = 4_200

/**
 * Which simulcast layer a tile needs, from its height in device pixels. The
 * layers are 180, 360 and 720 lines; a tile gets the smallest one that still
 * looks sharp at its size.
 */
export function qualityForTile(name: string, devicePixels: number): Quality {
  if (name.startsWith('screen.')) return 'high'
  if (devicePixels > 400) return 'high'
  if (devicePixels > 200) return 'medium'
  return 'low'
}

let reactionId = 1

/**
 * Runs one tab's participation in one meeting: the signaling socket, the media
 * connection, and the local camera, microphone and screen. Components read the
 * meeting store and call these methods; nothing else touches the connection.
 */
export class MeetingController {
  readonly code: string
  private readonly name: string
  private hostKey: string | null
  private signaling: Signaling | null = null
  private rtc: RtcSession | null = null
  private iceServers: JoinedPayload['ice_servers'] = []
  private disposed = false

  private tileSizes = new Map<string, number>()
  private subscriptionTimer: ReturnType<typeof setTimeout> | undefined
  private lastSubscriptions = ''
  private seenLobby = new Set<string>()
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined
  private statsTimer: ReturnType<typeof setInterval> | undefined
  private stopMicWatch: (() => void) | null = null
  private talkingSince = 0
  private lastTalkingHint = 0
  private heldToTalk = false

  constructor(opts: JoinOptions) {
    this.code = opts.code
    this.name = opts.name
    this.hostKey = opts.hostKey
    useMeeting.setState(initialMeetingState(opts.code), true)
    useLevels.setState({ levels: {} })
    if (opts.micTrack) opts.micTrack.enabled = opts.micOn
    if (opts.cameraTrack && !opts.cameraOn) {
      opts.cameraTrack.stop()
      opts.cameraTrack = null
    }
    this.patchLocal({
      micTrack: opts.micTrack,
      cameraTrack: opts.cameraTrack,
      micOn: opts.micOn && !!opts.micTrack,
      cameraOn: opts.cameraOn && !!opts.cameraTrack,
    })
    this.watchMic()
  }

  // ---- lifecycle -------------------------------------------------------

  start(): void {
    this.signaling = new Signaling(socketUrl(this.code), {
      onOpen: () => this.send('join', {
        name: this.name,
        host_key: this.hostKey ?? undefined,
        resume_token: storage.resumeToken(this.code) ?? undefined,
      }),
      onMessage: (type, data) => this.handle(type, data),
      onStatus: (socket) => useMeeting.setState({ socket }),
      onClosed: (code) => this.handleClosed(code),
    })
    this.signaling.connect()
    this.statsTimer = setInterval(() => void this.sampleNetwork(), 3_000)
  }

  /** Leaves the meeting on purpose. */
  leave(): void {
    if (this.disposed) return
    this.send('leave')
    storage.setResumeToken(this.code, null)
    this.finish('left', null)
  }

  /** Tears everything down without changing the phase, for unmounting. */
  dispose(): void {
    if (this.disposed) return
    if (useMeeting.getState().phase === 'joined' || useMeeting.getState().phase === 'waiting') {
      this.send('leave')
      storage.setResumeToken(this.code, null)
    }
    this.teardown()
  }

  private finish(phase: Phase, by: string | null): void {
    this.teardown()
    useMeeting.setState({ phase, phaseBy: by, panel: null })
  }

  private teardown(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.subscriptionTimer)
    clearTimeout(this.rebuildTimer)
    clearInterval(this.statsTimer)
    this.stopMicWatch?.()
    this.signaling?.close()
    this.rtc?.close()
    this.rtc = null
    const { local } = useMeeting.getState()
    local.micTrack?.stop()
    local.cameraTrack?.stop()
    local.screenTrack?.stop()
    this.patchLocal({ micTrack: null, cameraTrack: null, screenTrack: null, sharing: false })
    useMeeting.setState({ remote: {}, media: 'closed' })
    useLevels.setState({ levels: {} })
  }

  private send<K extends keyof ClientMessages>(type: K, data?: ClientMessages[K]): boolean {
    return this.signaling?.send(type, data) ?? false
  }

  // ---- server messages -------------------------------------------------

  private handle<K extends keyof ServerMessages>(type: K, raw: ServerMessages[K]): void {
    if (this.disposed) return
    const data = raw as never
    switch (type) {
      case 'joined':
        return this.handleJoined(data as JoinedPayload)
      case 'waiting': {
        const w = data as ServerMessages['waiting']
        storage.setResumeToken(this.code, w.resume_token)
        useMeeting.setState({ phase: 'waiting' })
        return
      }
      case 'denied': {
        const d = data as ServerMessages['denied']
        const phase: Phase = d.reason === 'not_found' ? 'not_found' : d.reason === 'full' ? 'full' : 'denied'
        return this.finish(phase, null)
      }
      case 'participants':
        return this.setParticipants((data as ServerMessages['participants']).participants)
      case 'lobby':
        return this.setLobby((data as ServerMessages['lobby']).lobby)
      case 'offer':
        void this.rtc?.handleOffer((data as ServerMessages['offer']).sdp)
        return
      case 'answer':
        void this.rtc?.handleAnswer((data as ServerMessages['answer']).sdp)
        return
      case 'candidate': {
        const c = data as ServerMessages['candidate']
        void this.rtc?.addCandidate({
          candidate: c.candidate,
          sdpMid: c.sdp_mid ?? undefined,
          sdpMLineIndex: c.sdp_mline_index ?? undefined,
          usernameFragment: c.username_fragment ?? undefined,
        })
        return
      }
      case 'chat':
        return this.receiveChat(data as ServerMessages['chat'])
      case 'reaction':
        return this.receiveReaction(data as ServerMessages['reaction'])
      case 'audio_levels': {
        const a = data as ServerMessages['audio_levels']
        useLevels.setState({ levels: a.levels ?? {} })
        const dominant = a.dominant
        if (dominant && dominant !== useMeeting.getState().dominant) {
          useMeeting.setState((s) => ({
            dominant,
            recentSpeakers: [dominant, ...s.recentSpeakers.filter((id) => id !== dominant)].slice(0, 8),
          }))
        }
        return
      }
      case 'force_mute': {
        const f = data as ServerMessages['force_mute']
        this.setMic(false)
        toast(`${f.by ?? 'A host'} muted you`, { key: 'force-mute' })
        return
      }
      case 'removed': {
        const r = data as ServerMessages['removed']
        storage.setResumeToken(this.code, null)
        return this.finish(r.reason === 'denied' ? 'denied' : 'removed', r.by ?? null)
      }
      case 'ended': {
        const e = data as ServerMessages['ended']
        storage.setResumeToken(this.code, null)
        return this.finish('ended', e.by ?? null)
      }
      case 'settings':
        return this.applySettings((data as ServerMessages['settings']).settings)
      case 'error':
        return this.handleError(data as ServerMessages['error'])
    }
  }

  private handleJoined(j: JoinedPayload): void {
    storage.setResumeToken(this.code, j.resume_token)
    storage.rememberMeeting(this.code)
    this.iceServers = j.ice_servers
    const prev = useMeeting.getState()
    const sameSession = j.resumed && prev.selfId === j.self.id
    useMeeting.setState({
      phase: 'joined',
      selfId: j.self.id,
      settings: j.meeting.settings,
      createdAt: j.meeting.created_at,
      chat: j.chat,
      unread: sameSession ? prev.unread : 0,
    })
    this.setParticipants(j.participants)
    this.setLobby(j.lobby)

    const rtcAlive = this.rtc && this.rtc.connectionState !== 'failed' && this.rtc.connectionState !== 'closed'
    if (sameSession && rtcAlive) {
      this.rtc!.resync()
    } else {
      this.buildMedia()
    }
    this.sendMediaState()
    this.lastSubscriptions = ''
    this.scheduleSubscriptions()
  }

  private handleClosed(code: number): void {
    const phase = useMeeting.getState().phase
    if (this.disposed || phase === 'left') return
    const byCode: Record<number, Phase> = {
      [CloseCode.Left]: 'left',
      [CloseCode.Removed]: 'removed',
      [CloseCode.Denied]: 'denied',
      [CloseCode.Ended]: 'ended',
      [CloseCode.NotFound]: 'not_found',
      [CloseCode.Full]: 'full',
      [CloseCode.Replaced]: 'replaced',
    }
    this.finish(byCode[code] ?? 'lost', useMeeting.getState().phaseBy)
  }

  private setParticipants(participants: Participant[]): void {
    const s = useMeeting.getState()
    const ids = new Set(participants.map((p) => p.id))
    const patch: Partial<MeetingState> = { participants }
    if (s.pinned) {
      const pinnedOwner = s.pinned.slice(s.pinned.indexOf('.') + 1)
      const owner = participants.find((p) => p.id === pinnedOwner)
      if (!owner || (s.pinned.startsWith('screen.') && !owner.screen_sharing)) patch.pinned = null
    }
    if (s.dominant && !ids.has(s.dominant)) patch.dominant = null
    useMeeting.setState(patch)

    // Someone stopped presenting: what they were sharing is no longer worth receiving.
    this.scheduleSubscriptions()
  }

  private setLobby(lobby: LobbyEntry[]): void {
    useMeeting.setState({ lobby })
    const host = useMeeting.getState().participants.find((p) => p.id === useMeeting.getState().selfId)?.is_host
    for (const entry of lobby) {
      if (this.seenLobby.has(entry.id)) continue
      this.seenLobby.add(entry.id)
      if (!host) continue
      toast(`${entry.name} wants to join this call`, {
        key: `knock-${entry.id}`,
        duration: 0,
        actions: [
          { label: 'Deny entry', onClick: () => this.deny(entry.id) },
          { label: 'Admit', onClick: () => this.admit(entry.id), primary: true },
        ],
      })
    }
    // Requests answered elsewhere, or withdrawn, take their toast with them.
    const waiting = new Set(lobby.map((l) => l.id))
    for (const id of this.seenLobby) {
      if (!waiting.has(id)) {
        dismissToastKey(`knock-${id}`)
        this.seenLobby.delete(id)
      }
    }
  }

  private receiveChat(msg: ServerMessages['chat']): void {
    const s = useMeeting.getState()
    const mine = msg.participant_id === s.selfId
    const open = s.panel === 'chat'
    useMeeting.setState({ chat: [...s.chat, msg].slice(-500), unread: open || mine ? s.unread : s.unread + 1 })
    if (!open && !mine) {
      toast(msg.text, {
        title: msg.name,
        key: 'chat',
        actions: [{ label: 'Open chat', onClick: () => this.openPanel('chat') }],
        duration: 6_000,
      })
    }
  }

  private receiveReaction(r: ServerMessages['reaction']): void {
    const s = useMeeting.getState()
    const who = r.participant_id === s.selfId ? 'You' : (s.participants.find((p) => p.id === r.participant_id)?.name ?? '')
    const reaction = { id: reactionId++, participantId: r.participant_id, name: who, emoji: r.emoji, lane: Math.random() }
    useMeeting.setState({ reactions: [...s.reactions, reaction].slice(-40) })
    setTimeout(() => {
      useMeeting.setState((st) => ({ reactions: st.reactions.filter((x) => x.id !== reaction.id) }))
    }, REACTION_LIFETIME_MS)
  }

  private applySettings(settings: Settings): void {
    const s = useMeeting.getState()
    useMeeting.setState({ settings })
    const host = s.participants.find((p) => p.id === s.selfId)?.is_host
    if (!host && !settings.screen_share_enabled && s.local.sharing) {
      void this.stopScreenShare()
      toast('The host turned off screen sharing')
    }
  }

  private handleError(e: ServerMessages['error']): void {
    switch (e.code) {
      case 'negotiation_failed':
        // The server lost track of this connection; start a fresh one.
        this.buildMedia()
        return
      case 'unknown_message':
      case 'bad_message':
        console.warn('[meet] server rejected a message:', e.message)
        return
      default:
        toast(e.message, { key: `error-${e.code}` })
    }
  }

  // ---- media connection ------------------------------------------------

  private buildMedia(): void {
    this.rtc?.close()
    clearTimeout(this.rebuildTimer)
    // A new connection is a new peer on the server; tell it again what to send.
    this.lastSubscriptions = ''
    useMeeting.setState({ remote: {}, media: 'new' })
    const { local } = useMeeting.getState()
    const rtc = new RtcSession(
      this.iceServers,
      {
        sendDescription: (type, sdp, streams, restart) => this.send(type, { sdp, streams, restart }),
        sendCandidate: (c) =>
          this.send('candidate', {
            candidate: c.candidate,
            sdp_mid: c.sdpMid,
            sdp_mline_index: c.sdpMLineIndex,
            username_fragment: c.usernameFragment,
          }),
        onRemoteTrack: ({ name, track }) => {
          if (this.rtc !== rtc) return
          useMeeting.setState((s) => {
            const remote: Record<string, MediaStreamTrack> = {}
            // A receiver's track is reused when the SFU recycles its m-line, so
            // the same track may move from one person to another.
            for (const [k, t] of Object.entries(s.remote)) if (t !== track) remote[k] = t
            remote[name] = track
            return { remote }
          })
          this.scheduleSubscriptions()
        },
        onRemoteTrackEnded: (name, track) => {
          if (this.rtc !== rtc) return
          useMeeting.setState((s) => {
            if (s.remote[name] !== track) return {}
            const remote = { ...s.remote }
            delete remote[name]
            return { remote }
          })
        },
        onConnectionState: (state) => {
          if (this.rtc !== rtc) return
          useMeeting.setState({ media: state })
          clearTimeout(this.rebuildTimer)
          if (state === 'failed' || state === 'disconnected') {
            // ICE restarts first; if the connection is still down after that,
            // build a new one.
            this.rebuildTimer = setTimeout(() => {
              if (this.rtc === rtc && rtc.connectionState !== 'connected' && this.signaling?.isOpen) {
                console.warn('[meet] media connection did not recover; rebuilding')
                this.buildMedia()
              }
            }, MEDIA_REBUILD_MS)
          }
        },
      },
      { mic: local.micTrack, camera: local.cameraOn ? local.cameraTrack : null },
    )
    this.rtc = rtc
    if (local.sharing && local.screenTrack) void rtc.setScreenTrack(local.screenTrack)
  }

  private sendMediaState(): void {
    const { local } = useMeeting.getState()
    this.send('media_state', { audio_muted: !local.micOn, video_on: local.cameraOn, screen_sharing: local.sharing })
  }

  private patchLocal(patch: Partial<MeetingState['local']>): void {
    useMeeting.setState((s) => ({ local: { ...s.local, ...patch } }))
  }

  // ---- what each tile wants to receive ---------------------------------

  /** A tile reports its height in device pixels, or 0 when it is gone. */
  reportTile(name: string, devicePixels: number): void {
    if (devicePixels > 0) this.tileSizes.set(name, devicePixels)
    else this.tileSizes.delete(name)
    this.scheduleSubscriptions()
  }

  private scheduleSubscriptions(): void {
    clearTimeout(this.subscriptionTimer)
    this.subscriptionTimer = setTimeout(() => this.sendSubscriptions(), SUBSCRIPTION_DEBOUNCE_MS)
  }

  private sendSubscriptions(): void {
    const { remote, participants } = useMeeting.getState()
    const qualities: Record<string, Quality> = {}
    const names = new Set([...Object.keys(remote), ...this.tileSizes.keys()])
    for (const name of names) {
      if (name.startsWith('mic.')) continue
      const owner = participants.find((p) => name.endsWith(`.${p.id}`))
      const px = this.tileSizes.get(name)
      // Tiles not on screen get nothing. A tile showing an avatar because the
      // camera is off still asks for its layer: the publisher sends nothing
      // meanwhile, and the first frame arrives the moment the camera turns on.
      qualities[name] = owner && px ? qualityForTile(name, px) : 'off'
    }
    const key = JSON.stringify(Object.entries(qualities).sort())
    if (key === this.lastSubscriptions) return
    if (this.send('subscriptions', { qualities })) this.lastSubscriptions = key
  }

  // ---- local media -----------------------------------------------------

  async toggleMic(): Promise<void> {
    await this.setMic(!useMeeting.getState().local.micOn)
  }

  async setMic(on: boolean): Promise<void> {
    let { micTrack } = useMeeting.getState().local
    if (on && (!micTrack || micTrack.readyState === 'ended')) {
      try {
        micTrack = await getMicrophone()
      } catch (err) {
        toast(describeMediaError(err, 'microphone') ?? "Couldn't start your microphone.")
        return
      }
      this.patchLocal({ micTrack })
      await this.rtc?.setMicTrack(micTrack)
      this.watchMic()
    }
    if (micTrack) micTrack.enabled = on
    this.patchLocal({ micOn: on && !!micTrack })
    if (on) dismissToastKey('talking-muted')
    this.sendMediaState()
  }

  /** Holding the space bar talks through a muted microphone until it is released. */
  holdToTalk(down: boolean): void {
    const { local } = useMeeting.getState()
    if (down && !local.micOn && local.micTrack) {
      this.heldToTalk = true
      void this.setMic(true)
    } else if (!down && this.heldToTalk) {
      this.heldToTalk = false
      void this.setMic(false)
    }
  }

  async toggleCamera(): Promise<void> {
    await this.setCamera(!useMeeting.getState().local.cameraOn)
  }

  async setCamera(on: boolean): Promise<void> {
    const { local } = useMeeting.getState()
    if (on === local.cameraOn) return
    if (!on) {
      // Stopping the track, not just muting it, turns the camera light off.
      await this.rtc?.setCameraTrack(null)
      local.cameraTrack?.stop()
      this.patchLocal({ cameraTrack: null, cameraOn: false })
      this.sendMediaState()
      return
    }
    let track: MediaStreamTrack
    try {
      track = await getCamera()
    } catch (err) {
      toast(describeMediaError(err, 'camera') ?? "Couldn't start your camera.")
      return
    }
    if (this.disposed) {
      track.stop()
      return
    }
    await this.rtc?.setCameraTrack(track)
    this.patchLocal({ cameraTrack: track, cameraOn: true })
    this.sendMediaState()
  }

  async startScreenShare(): Promise<void> {
    const s = useMeeting.getState()
    const host = s.participants.find((p) => p.id === s.selfId)?.is_host
    if (!host && !s.settings.screen_share_enabled) {
      toast('The host has turned off screen sharing')
      return
    }
    let track: MediaStreamTrack
    try {
      track = await getScreen()
    } catch (err) {
      // Screen capture must follow a click closely. "Present" in the green room
      // can outlive that window while the call connects; a button restores it.
      if (err instanceof DOMException && err.name === 'InvalidStateError') {
        toast('Your call is ready for you to present.', {
          key: 'present-ready',
          actions: [{ label: 'Present now', onClick: () => void this.startScreenShare(), primary: true }],
        })
        return
      }
      const message = describeMediaError(err, 'screen')
      if (message) toast(message)
      return
    }
    if (this.disposed) {
      track.stop()
      return
    }
    // The browser's own "Stop sharing" bar ends the track directly.
    track.addEventListener('ended', () => {
      if (useMeeting.getState().local.screenTrack === track) void this.stopScreenShare()
    })
    useMeeting.getState().local.screenTrack?.stop()
    await this.rtc?.setScreenTrack(track)
    this.patchLocal({ screenTrack: track, sharing: true })
    this.sendMediaState()
  }

  async stopScreenShare(): Promise<void> {
    const { local } = useMeeting.getState()
    await this.rtc?.setScreenTrack(null)
    local.screenTrack?.stop()
    this.patchLocal({ screenTrack: null, sharing: false })
    this.sendMediaState()
  }

  async switchDevice(kind: 'audioinput' | 'videoinput' | 'audiooutput', deviceId: string): Promise<void> {
    storage.setDevice(kind, deviceId)
    const { local } = useMeeting.getState()
    if (kind === 'audiooutput') {
      useMeeting.setState({ speakerId: deviceId })
      return
    }
    try {
      if (kind === 'audioinput' && local.micTrack) {
        const track = await getMicrophone(deviceId)
        track.enabled = local.micOn
        await this.rtc?.setMicTrack(track)
        local.micTrack.stop()
        this.patchLocal({ micTrack: track })
        this.watchMic()
      } else if (kind === 'videoinput' && local.cameraOn) {
        const track = await getCamera(deviceId)
        await this.rtc?.setCameraTrack(track)
        local.cameraTrack?.stop()
        this.patchLocal({ cameraTrack: track })
      }
    } catch (err) {
      toast(describeMediaError(err, kind === 'audioinput' ? 'microphone' : 'camera') ?? "Couldn't switch devices.")
    }
  }

  async setNoiseSuppression(on: boolean): Promise<void> {
    storage.setBool('noise', on)
    await useMeeting.getState().local.micTrack?.applyConstraints({ noiseSuppression: on }).catch(() => {})
  }

  /**
   * Notices someone talking into a muted microphone and offers to unmute them,
   * at most once every half minute.
   */
  private watchMic(): void {
    this.stopMicWatch?.()
    const track = useMeeting.getState().local.micTrack
    if (!track) return
    this.stopMicWatch = watchLevel(track, (level) => {
      const { local, phase } = useMeeting.getState()
      if (phase !== 'joined' || local.micOn || level < 0.45) {
        this.talkingSince = 0
        return
      }
      const now = Date.now()
      if (!this.talkingSince) this.talkingSince = now
      if (now - this.talkingSince > 800 && now - this.lastTalkingHint > 30_000) {
        this.lastTalkingHint = now
        toast('Are you talking? Your mic is off.', {
          key: 'talking-muted',
          actions: [{ label: 'Turn on mic', onClick: () => void this.setMic(true), primary: true }],
          duration: 6_000,
        })
      }
    })
  }

  // ---- in-call actions -------------------------------------------------

  sendChat(text: string): void {
    const trimmed = text.trim()
    if (trimmed) this.send('chat', { text: trimmed })
  }

  setHand(raised: boolean): void {
    this.send('hand', { raised })
  }

  react(emoji: string): void {
    this.send('reaction', { emoji })
  }

  openPanel(panel: MeetingState['panel']): void {
    const s = useMeeting.getState()
    const next = s.panel === panel ? null : panel
    useMeeting.setState({ panel: next, unread: next === 'chat' ? 0 : s.unread })
    if (next === 'chat') dismissToastKey('chat')
  }

  pin(tile: string | null): void {
    useMeeting.setState((s) => ({ pinned: s.pinned === tile ? null : tile }))
  }

  // ---- host actions ----------------------------------------------------

  mute(participantId: string): void {
    this.send('mute', { participant_id: participantId })
  }
  muteAll(): void {
    this.send('mute_all')
  }
  remove(participantId: string): void {
    this.send('remove', { participant_id: participantId })
  }
  lowerHand(participantId: string): void {
    this.send('lower_hand', { participant_id: participantId })
  }
  admit(participantId: string): void {
    dismissToastKey(`knock-${participantId}`)
    this.send('admit', { participant_id: participantId })
  }
  admitAll(): void {
    this.send('admit_all')
  }
  deny(participantId: string): void {
    dismissToastKey(`knock-${participantId}`)
    this.send('deny', { participant_id: participantId })
  }
  makeHost(participantId: string): void {
    this.send('make_host', { participant_id: participantId })
  }
  updateSettings(patch: Partial<Settings>): void {
    this.send('settings', patch)
  }
  endForEveryone(): void {
    this.send('end_meeting')
  }

  // ---- diagnostics -----------------------------------------------------

  private async sampleNetwork(): Promise<void> {
    const rtc = this.rtc
    if (!rtc || rtc.connectionState !== 'connected') return
    let rtt = 0
    let lost = 0
    try {
      const report = await rtc.pc.getStats()
      report.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') rtt = s.currentRoundTripTime ?? 0
        if (s.type === 'remote-inbound-rtp' && s.kind === 'video') lost = Math.max(lost, s.fractionLost ?? 0)
      })
    } catch {
      return
    }
    const network: NetworkQuality = rtt > 0.4 || lost > 0.1 ? 'poor' : rtt > 0.2 || lost > 0.03 ? 'fair' : 'good'
    if (network !== useMeeting.getState().network) useMeeting.setState({ network })
  }

  /** Inbound and outbound video as the browser sees it, for tests and debugging. */
  async videoStats(): Promise<{
    outbound: { rid?: string; width?: number; height?: number; fps?: number; bytes: number }[]
    inbound: { track: string; width?: number; height?: number; framesDecoded: number }[]
  }> {
    const out: Awaited<ReturnType<MeetingController['videoStats']>> = { outbound: [], inbound: [] }
    const rtc = this.rtc
    if (!rtc) return out
    const report = await rtc.pc.getStats()
    const midToName = new Map<string, string>()
    for (const t of rtc.pc.getTransceivers()) {
      const name = Object.entries(useMeeting.getState().remote).find(([, tr]) => tr === t.receiver.track)?.[0]
      if (t.mid && name) midToName.set(t.mid, name)
    }
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        out.outbound.push({ rid: s.rid, width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond, bytes: s.bytesSent })
      }
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        out.inbound.push({
          track: midToName.get(s.mid) ?? s.trackIdentifier,
          width: s.frameWidth,
          height: s.frameHeight,
          framesDecoded: s.framesDecoded ?? 0,
        })
      }
    })
    return out
  }
}
