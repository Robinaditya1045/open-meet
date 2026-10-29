import { Mic, MicOff, MonitorUp, Video, VideoOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/common/Button'
import { IconButton } from '../components/common/IconButton'
import { Logo } from '../components/common/Logo'
import { DevicePicker } from '../components/media/DevicePicker'
import { LevelDots } from '../components/media/LevelDots'
import { VideoView } from '../components/media/VideoView'
import { useDevices } from '../hooks/useMisc'
import { ApiError, getMeeting, type MeetingSummary } from '../lib/api'
import { namesSentence } from '../lib/format'
import { unlockAudio, watchLevel } from '../lib/rtc/audioLevel'
import {
  canPickSpeaker,
  canShareScreen,
  describeMediaError,
  getCamera,
  getMicrophone,
  setTrackEnabled,
} from '../lib/rtc/devices'
import { storage } from '../lib/storage'
import styles from './GreenRoom.module.css'

export interface GreenRoomResult {
  name: string
  micTrack: MediaStreamTrack | null
  cameraTrack: MediaStreamTrack | null
  micOn: boolean
  cameraOn: boolean
  present: boolean
}

interface GreenRoomProps {
  code: string
  isHost: boolean
  onJoin: (result: GreenRoomResult) => void
  onNotFound: () => void
}

/**
 * Asks for the camera and microphone together, so the browser shows one prompt,
 * and falls back to each alone so that a refused camera doesn't cost the mic.
 */
async function openPreview(wantMic: boolean, wantCamera: boolean) {
  const result: {
    mic: MediaStreamTrack | null
    camera: MediaStreamTrack | null
    micError: string | null
    cameraError: string | null
  } = { mic: null, camera: null, micError: null, cameraError: null }
  if (!navigator.mediaDevices?.getUserMedia) {
    result.micError = result.cameraError = 'This browser cannot use a camera or microphone here. Use HTTPS or localhost.'
    return result
  }
  if (wantMic) {
    try {
      result.mic = await getMicrophone()
    } catch (err) {
      result.micError = describeMediaError(err, 'microphone')
    }
  }
  if (wantCamera) {
    try {
      result.camera = await getCamera()
    } catch (err) {
      result.cameraError = describeMediaError(err, 'camera')
    }
  }
  return result
}

export function GreenRoom({ code, isHost, onJoin, onNotFound }: GreenRoomProps) {
  const [name, setName] = useState(storage.displayName())
  const [micOn, setMicOn] = useState(() => storage.bool('mic', true))
  const [cameraOn, setCameraOn] = useState(() => storage.bool('camera', true))
  const [micTrack, setMicTrack] = useState<MediaStreamTrack | null>(null)
  const [cameraTrack, setCameraTrack] = useState<MediaStreamTrack | null>(null)
  const [micError, setMicError] = useState<string | null>(null)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  const [level, setLevel] = useState(0)
  const [summary, setSummary] = useState<MeetingSummary | null>(null)
  const [speaker, setSpeaker] = useState(storage.device('audiooutput'))
  const handedOver = useRef(false)
  const tracks = useRef<{ mic: MediaStreamTrack | null; camera: MediaStreamTrack | null }>({ mic: null, camera: null })
  const devices = useDevices(`${micTrack?.id}-${cameraTrack?.id}`)

  useEffect(() => {
    tracks.current = { mic: micTrack, camera: cameraTrack }
  }, [micTrack, cameraTrack])

  // Open the devices the person used last time.
  useEffect(() => {
    let cancelled = false
    void openPreview(storage.bool('mic', true), storage.bool('camera', true)).then((r) => {
      if (cancelled) {
        r.mic?.stop()
        r.camera?.stop()
        return
      }
      setMicTrack(r.mic)
      setCameraTrack(r.camera)
      setMicError(r.micError)
      setCameraError(r.cameraError)
      if (!r.mic) setMicOn(false)
      if (!r.camera) setCameraOn(false)
      setStarting(false)
    })
    return () => {
      cancelled = true
      if (!handedOver.current) {
        tracks.current.mic?.stop()
        tracks.current.camera?.stop()
      }
    }
  }, [])

  useEffect(() => {
    if (!micTrack) return
    setTrackEnabled(micTrack, micOn)
    return watchLevel(micTrack, setLevel)
  }, [micTrack, micOn])

  // Who is already in the call, refreshed while waiting here.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      getMeeting(code)
        .then((s) => !cancelled && setSummary(s))
        .catch((err) => {
          if (!cancelled && err instanceof ApiError && err.status === 404) onNotFound()
        })
    void load()
    const timer = setInterval(load, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [code, onNotFound])

  const toggleMic = async () => {
    if (micOn) {
      setMicOn(false)
      return
    }
    if (!micTrack) {
      try {
        setMicTrack(await getMicrophone())
        setMicError(null)
      } catch (err) {
        setMicError(describeMediaError(err, 'microphone'))
        return
      }
    }
    setMicOn(true)
  }

  const toggleCamera = async () => {
    if (cameraOn) {
      cameraTrack?.stop()
      setCameraTrack(null)
      setCameraOn(false)
      return
    }
    try {
      setCameraTrack(await getCamera())
      setCameraError(null)
      setCameraOn(true)
    } catch (err) {
      setCameraError(describeMediaError(err, 'camera'))
    }
  }

  const switchDevice = async (kind: 'audioinput' | 'videoinput' | 'audiooutput', id: string) => {
    storage.setDevice(kind, id)
    if (kind === 'audiooutput') {
      setSpeaker(id)
      return
    }
    try {
      if (kind === 'audioinput') {
        const next = await getMicrophone(id)
        micTrack?.stop()
        setMicTrack(next)
      } else if (cameraOn) {
        const next = await getCamera(id)
        cameraTrack?.stop()
        setCameraTrack(next)
      }
    } catch (err) {
      const message = describeMediaError(err, kind === 'audioinput' ? 'microphone' : 'camera')
      if (kind === 'audioinput') setMicError(message)
      else setCameraError(message)
    }
  }

  const trimmed = name.trim()
  const askToJoin = !!summary?.locked && !isHost

  const join = (present: boolean) => {
    if (!trimmed) return
    unlockAudio()
    storage.setDisplayName(trimmed)
    storage.setBool('mic', micOn)
    storage.setBool('camera', cameraOn)
    handedOver.current = true
    onJoin({ name: trimmed, micTrack, cameraTrack: cameraOn ? cameraTrack : null, micOn, cameraOn, present })
  }

  const othersHere = summary
    ? summary.participant_count === 0
      ? 'No one else is here'
      : `${namesSentence(summary.names, summary.participant_count)} ${summary.participant_count === 1 ? 'is' : 'are'} in this call`
    : ' '

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Logo />
      </header>
      <main className={styles.main}>
        <section className={styles.previewColumn}>
          <div className={styles.preview} data-surface="call">
            {cameraOn && cameraTrack ? (
              <VideoView track={cameraTrack} mirrored={storage.bool('mirror', true)} />
            ) : (
              <div className={styles.cameraOff}>
                {starting ? 'Starting camera…' : (cameraError ?? 'Camera is off')}
              </div>
            )}
            {trimmed && <div className={styles.previewName}>{trimmed}</div>}
            <div className={styles.previewControls}>
              <div className={styles.micControl}>
                <IconButton
                  variant="control"
                  tone={micOn ? 'default' : 'off'}
                  label={micOn ? 'Turn off microphone' : 'Turn on microphone'}
                  icon={micOn ? <Mic /> : <MicOff />}
                  onClick={() => void toggleMic()}
                />
                {micOn && <LevelDots level={level} className={styles.level} />}
              </div>
              <IconButton
                variant="control"
                tone={cameraOn ? 'default' : 'off'}
                label={cameraOn ? 'Turn off camera' : 'Turn on camera'}
                icon={cameraOn ? <Video /> : <VideoOff />}
                onClick={() => void toggleCamera()}
              />
            </div>
          </div>
          {micError && micError !== cameraError && <p className={styles.deviceError}>{micError}</p>}
          <div className={styles.devices}>
            <DevicePicker
              kind="audioinput"
              devices={devices.audioinput}
              selected={micTrack?.getSettings().deviceId ?? storage.device('audioinput')}
              onSelect={(id) => void switchDevice('audioinput', id)}
            />
            {canPickSpeaker && (
              <DevicePicker
                kind="audiooutput"
                devices={devices.audiooutput}
                selected={speaker}
                onSelect={(id) => void switchDevice('audiooutput', id)}
              />
            )}
            <DevicePicker
              kind="videoinput"
              devices={devices.videoinput}
              selected={cameraTrack?.getSettings().deviceId ?? storage.device('videoinput')}
              onSelect={(id) => void switchDevice('videoinput', id)}
            />
          </div>
        </section>

        <section className={styles.joinColumn}>
          <h1 className={styles.ready}>{askToJoin ? 'Ask to join?' : 'Ready to join?'}</h1>
          <p className={styles.others}>{othersHere}</p>
          <label className={styles.nameField}>
            <span>Your name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && join(false)}
              placeholder="What's your name?"
              maxLength={60}
              autoFocus={!name}
              autoComplete="name"
            />
          </label>
          <div className={styles.joinButtons}>
            <Button size="lg" onClick={() => join(false)} disabled={!trimmed || starting}>
              {askToJoin ? 'Ask to join' : 'Join now'}
            </Button>
            {!askToJoin && canShareScreen && (
              <Button size="lg" variant="outline" icon={<MonitorUp />} onClick={() => join(true)} disabled={!trimmed || starting}>
                Present
              </Button>
            )}
          </div>
          <p className={styles.code}>
            Meeting code <span>{code}</span>
            {isHost && <span className={styles.hostBadge}>You're a host</span>}
          </p>
        </section>
      </main>
    </div>
  )
}
