import { storage } from '../storage'

export type DeviceKind = 'audioinput' | 'videoinput' | 'audiooutput'

export interface DeviceList {
  audioinput: MediaDeviceInfo[]
  videoinput: MediaDeviceInfo[]
  audiooutput: MediaDeviceInfo[]
}

export async function listDevices(): Promise<DeviceList> {
  const out: DeviceList = { audioinput: [], videoinput: [], audiooutput: [] }
  if (!navigator.mediaDevices?.enumerateDevices) return out
  for (const d of await navigator.mediaDevices.enumerateDevices()) {
    // Before permission is granted devices come back with empty IDs and labels.
    if (d.deviceId && d.kind in out) out[d.kind as DeviceKind].push(d)
  }
  return out
}

function audioConstraints(deviceId: string | null, noiseSuppression: boolean): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression,
    autoGainControl: true,
  }
}

function videoConstraints(deviceId: string | null): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    // 720p is what the top simulcast layer is sized for; the lower layers are
    // scaled from it.
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
    aspectRatio: { ideal: 16 / 9 },
  }
}

/**
 * Asks for one device, falling back to the default when the remembered one has
 * been unplugged, so a missing headset never blocks joining.
 */
async function acquire(kind: 'audio' | 'video', build: (id: string | null) => MediaTrackConstraints, deviceId: string | null) {
  const request = (id: string | null) =>
    navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: build(id) } : { video: build(id) })
  let stream: MediaStream
  try {
    stream = await request(deviceId)
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ''
    if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw err
    stream = await request(null)
  }
  const [track] = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks()
  if (!track) throw new DOMException('No track', 'NotFoundError')
  return track
}

export function getMicrophone(deviceId = storage.device('audioinput'), noiseSuppression = storage.bool('noise', true)) {
  return acquire('audio', (id) => audioConstraints(id, noiseSuppression), deviceId)
}

export function getCamera(deviceId = storage.device('videoinput')) {
  return acquire('video', videoConstraints, deviceId)
}

export async function getScreen(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
    audio: false,
  })
  const [track] = stream.getVideoTracks()
  if (!track) throw new DOMException('No track', 'NotFoundError')
  // Encoders favour sharpness over motion for "detail" content.
  track.contentHint = 'detail'
  return track
}

/** Why a device could not be opened, in words a person can act on. Null when they chose not to. */
export function describeMediaError(err: unknown, what: 'camera' | 'microphone' | 'screen'): string | null {
  const name = err instanceof DOMException ? err.name : ''
  if (what === 'screen') {
    if (name === 'NotAllowedError' || name === 'AbortError') return null
    return 'Screen sharing is not available in this browser.'
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Your ${what} is blocked. Allow it from the camera icon in the address bar, then try again.`
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${what} was found.`
    case 'NotReadableError':
      return `Your ${what} is in use by another app.`
    default:
      return `Couldn't start your ${what}.`
  }
}

/**
 * Mutes or unmutes a track in place. Tracks are browser resources held by
 * reference, not React state to be copied, so toggling one is a call like this.
 */
export function setTrackEnabled(track: MediaStreamTrack | null, enabled: boolean): void {
  if (track) track.enabled = enabled
}

/** Phone browsers have no screen capture at all; there is no point offering it. */
export const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

/** Whether this browser lets a page choose its audio output. */
export const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
