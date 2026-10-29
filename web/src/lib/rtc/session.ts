import { parseTrackName, type IceServer, type MediaKind } from '../protocol'

export interface RemoteTrack {
  /** "camera.<participantId>" */
  name: string
  kind: MediaKind
  participantId: string
  track: MediaStreamTrack
}

export interface RtcCallbacks {
  sendDescription: (type: 'offer' | 'answer', sdp: string, streams: Record<string, MediaKind>, restart: boolean) => void
  sendCandidate: (candidate: RTCIceCandidate) => void
  onRemoteTrack: (track: RemoteTrack) => void
  onRemoteTrackEnded: (name: string, track: MediaStreamTrack) => void
  onConnectionState: (state: RTCPeerConnectionState) => void
}

/**
 * The camera goes out as three encodings of the same picture. The SFU forwards
 * whichever one fits each viewer's tile, so a thumbnail costs a viewer 150 kbps
 * instead of the full 1.5 Mbps, and nobody's slow downlink degrades anyone else.
 */
const CAMERA_ENCODINGS: RTCRtpEncodingParameters[] = [
  { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150_000, maxFramerate: 15 },
  { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 500_000, maxFramerate: 30 },
  { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 1_500_000, maxFramerate: 30 },
]

/** Screen shares are one encoding: text is unreadable at a quarter of the resolution. */
const SCREEN_ENCODING: RTCRtpEncodingParameters = { maxBitrate: 2_500_000, maxFramerate: 30 }

/**
 * One participant's connection to the SFU.
 *
 * Publishing uses transceivers created once, up front, as sendonly. Turning a
 * camera off or on, or switching devices, is then a replaceTrack — no
 * renegotiation, no waiting on the server, and no flash of "camera off" on
 * anyone else's screen while an offer is in flight. Only the first screen share
 * adds a transceiver.
 *
 * Receiving is driven by the SFU, which offers a new set of tracks whenever
 * someone joins, leaves or starts presenting. This side is the polite peer: when
 * offers collide it yields, answers the SFU, and offers again afterwards.
 */
export class RtcSession {
  readonly pc: RTCPeerConnection
  private readonly mic: RTCRtpTransceiver
  private readonly camera: RTCRtpTransceiver
  private screen: RTCRtpTransceiver | null = null
  /**
   * Stable stream identities for what this client publishes. Their IDs travel in
   * the SDP msid, which is how the SFU tells a camera from a screen share.
   */
  private readonly streams = { mic: new MediaStream(), camera: new MediaStream(), screen: new MediaStream() }
  private readonly callbacks: RtcCallbacks

  /**
   * Signaling runs one step at a time. Offers, answers and candidates arrive in
   * bursts, and applying two concurrently leaves the connection in a state
   * neither side expects.
   */
  private chain: Promise<void> = Promise.resolve()
  private negotiationQueued = false
  private offeredOnce = false
  private pendingCandidates: RTCIceCandidateInit[] = []
  private closed = false

  constructor(
    iceServers: IceServer[],
    callbacks: RtcCallbacks,
    initial: { mic: MediaStreamTrack | null; camera: MediaStreamTrack | null },
  ) {
    this.callbacks = callbacks
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })
    this.pc = pc

    this.mic = pc.addTransceiver(initial.mic ?? 'audio', { direction: 'sendonly', streams: [this.streams.mic] })
    this.camera = pc.addTransceiver(initial.camera ?? 'video', {
      direction: 'sendonly',
      streams: [this.streams.camera],
      sendEncodings: CAMERA_ENCODINGS,
    })

    pc.onnegotiationneeded = () => this.negotiate()
    pc.onicecandidate = (event) => {
      if (event.candidate) this.callbacks.sendCandidate(event.candidate)
    }
    pc.ontrack = (event) => this.handleTrack(event)
    pc.onconnectionstatechange = () => this.callbacks.onConnectionState(pc.connectionState)
    pc.oniceconnectionstatechange = () => {
      // A network change (Wi-Fi to cellular, a VPN, a laptop waking) breaks the
      // candidate pair, not the session. Restarting ICE recovers the call in
      // place instead of rebuilding everyone's media.
      if (pc.iceConnectionState === 'failed') pc.restartIce()
    }
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    this.chain = this.chain
      .catch(() => {})
      .then(() => (this.closed ? undefined : step()))
      .catch((err) => console.warn('[rtc] signaling step failed', err))
    return this.chain
  }

  /**
   * Offers this client's current transceivers, or remembers to once the
   * exchange in flight is over. A dropped renegotiation is media that never
   * starts, so it is deferred rather than skipped.
   */
  private negotiate(): void {
    void this.enqueue(async () => {
      if (this.pc.signalingState !== 'stable') {
        this.negotiationQueued = true
        return
      }
      this.negotiationQueued = false
      await this.pc.setLocalDescription()
      const local = this.pc.localDescription
      if (!local) return
      // The first offer of a connection tells the server to drop any connection
      // it still holds for this participant: that one can never be resumed.
      const restart = !this.offeredOnce
      this.offeredOnce = true
      this.callbacks.sendDescription('offer', local.sdp, this.describeStreams(), restart)
    })
  }

  private resumeQueuedNegotiation(): void {
    if (!this.negotiationQueued) return
    this.negotiationQueued = false
    this.negotiate()
  }

  private describeStreams(): Record<string, MediaKind> {
    return {
      [this.streams.mic.id]: 'mic',
      [this.streams.camera.id]: 'camera',
      [this.streams.screen.id]: 'screen',
    }
  }

  private handleTrack(event: RTCTrackEvent): void {
    const track = event.track
    const stream = event.streams[0]
    const identity = stream ? parseTrackName(stream.id) : null
    if (!stream || !identity) return

    const name = stream.id
    this.callbacks.onRemoteTrack({ name, ...identity, track })

    // A forwarded track goes away when the SFU marks its m-line inactive, which
    // removes it from its stream. The receiver's track object outlives that and
    // may later carry someone else, so the stream is the signal, not the track.
    const onRemove = (e: MediaStreamTrackEvent) => {
      if (e.track !== track) return
      stream.removeEventListener('removetrack', onRemove)
      this.callbacks.onRemoteTrackEnded(name, track)
    }
    stream.addEventListener('removetrack', onRemove)
    track.addEventListener('ended', () => this.callbacks.onRemoteTrackEnded(name, track), { once: true })
  }

  /** Applies an SFU offer and answers it. An offer of ours in flight is rolled back implicitly. */
  handleOffer(sdp: string): Promise<void> {
    return this.enqueue(async () => {
      await this.pc.setRemoteDescription({ type: 'offer', sdp })
      await this.flushCandidates()
      await this.pc.setLocalDescription()
      const local = this.pc.localDescription
      if (local) this.callbacks.sendDescription('answer', local.sdp, this.describeStreams(), false)
      this.resumeQueuedNegotiation()
    })
  }

  handleAnswer(sdp: string): Promise<void> {
    return this.enqueue(async () => {
      // An answer to an offer that was rolled back; applying it would undo the
      // exchange that replaced it.
      if (this.pc.signalingState !== 'have-local-offer') return
      await this.pc.setRemoteDescription({ type: 'answer', sdp })
      await this.flushCandidates()
      this.resumeQueuedNegotiation()
    })
  }

  addCandidate(init: RTCIceCandidateInit): Promise<void> {
    return this.enqueue(async () => {
      // Candidates routinely beat the description they belong to.
      if (!this.pc.remoteDescription) {
        this.pendingCandidates.push(init)
        return
      }
      await this.pc.addIceCandidate(init).catch(() => {})
    })
  }

  private async flushCandidates(): Promise<void> {
    const pending = this.pendingCandidates
    this.pendingCandidates = []
    for (const c of pending) await this.pc.addIceCandidate(c).catch(() => {})
  }

  /**
   * Picks signaling back up after the socket reconnected. An offer sent while
   * the socket was dying may never have arrived, and its answer certainly
   * didn't, so it goes out again; answering the same offer twice is harmless.
   */
  resync(): void {
    void this.enqueue(async () => {
      const local = this.pc.localDescription
      if (this.pc.signalingState === 'have-local-offer' && local) {
        this.callbacks.sendDescription('offer', local.sdp, this.describeStreams(), false)
      }
    })
  }

  setMicTrack(track: MediaStreamTrack | null): Promise<void> {
    return this.mic.sender.replaceTrack(track)
  }

  setCameraTrack(track: MediaStreamTrack | null): Promise<void> {
    return this.camera.sender.replaceTrack(track)
  }

  async setScreenTrack(track: MediaStreamTrack | null): Promise<void> {
    if (this.screen) {
      await this.screen.sender.replaceTrack(track)
      return
    }
    if (!track) return
    // The first share adds a transceiver, which negotiationneeded publishes.
    // Later shares reuse it.
    this.screen = this.pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [this.streams.screen],
      sendEncodings: [SCREEN_ENCODING],
    })
    try {
      const params = this.screen.sender.getParameters()
      // Keep text sharp and drop frames instead when bandwidth runs short.
      params.degradationPreference = 'maintain-resolution'
      await this.screen.sender.setParameters(params)
    } catch {
      // Not supported everywhere; the default is acceptable.
    }
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState
  }

  close(): void {
    this.closed = true
    const pc = this.pc
    pc.onnegotiationneeded = null
    pc.onicecandidate = null
    pc.ontrack = null
    pc.onconnectionstatechange = null
    pc.oniceconnectionstatechange = null
    pc.close()
  }
}
