import { useEffect, useState } from 'react'
import { useDevices } from '../../hooks/useMisc'
import { watchLevel } from '../../lib/rtc/audioLevel'
import { canPickSpeaker } from '../../lib/rtc/devices'
import { storage } from '../../lib/storage'
import type { MeetingController } from '../../meeting/controller'
import { useMeeting } from '../../state/meeting'
import { Dialog } from '../common/Dialog'
import { Switch } from '../common/Switch'
import { VideoView } from '../media/VideoView'
import styles from './SettingsDialog.module.css'

type Tab = 'audio' | 'video' | 'general'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  controller: MeetingController
}

function DeviceSelect({
  label,
  devices,
  value,
  onChange,
}: {
  label: string
  devices: MediaDeviceInfo[]
  value: string | null
  onChange: (id: string) => void
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select value={value ?? devices[0]?.deviceId ?? ''} onChange={(e) => onChange(e.target.value)} disabled={!devices.length}>
        {devices.length === 0 && <option value="">No devices found</option>}
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  )
}

/** A short chime through the chosen speakers. */
async function playTestSound(sinkId: string | null) {
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  const gain = ctx.createGain()
  gain.connect(dest)
  ;[660, 880].forEach((freq, i) => {
    const osc = ctx.createOscillator()
    osc.frequency.value = freq
    osc.connect(gain)
    osc.start(ctx.currentTime + i * 0.18)
    osc.stop(ctx.currentTime + i * 0.18 + 0.16)
  })
  gain.gain.setValueAtTime(0.18, ctx.currentTime)
  const el = new Audio() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  el.srcObject = dest.stream
  if (sinkId && el.setSinkId) await el.setSinkId(sinkId).catch(() => {})
  await el.play().catch(() => {})
  setTimeout(() => {
    el.srcObject = null
    void ctx.close()
  }, 600)
}

export function SettingsDialog({ open, onOpenChange, controller }: SettingsDialogProps) {
  const [tab, setTab] = useState<Tab>('audio')
  const local = useMeeting((s) => s.local)
  const speakerId = useMeeting((s) => s.speakerId)
  const devices = useDevices(`${open}-${local.micTrack?.id}-${local.cameraTrack?.id}`)
  const [level, setLevel] = useState(0)
  const [noise, setNoise] = useState(() => storage.bool('noise', true))
  const [mirror, setMirror] = useState(() => storage.bool('mirror', true))

  useEffect(() => {
    if (!open || tab !== 'audio' || !local.micTrack) return
    return watchLevel(local.micTrack, setLevel)
  }, [open, tab, local.micTrack])

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Settings" size="lg" dark>
      <div className={styles.layout}>
        <nav className={styles.tabs} aria-label="Settings sections">
          {(['audio', 'video', 'general'] as Tab[]).map((t) => (
            <button key={t} type="button" aria-current={tab === t} className={styles.tab} onClick={() => setTab(t)}>
              {t === 'audio' ? 'Audio' : t === 'video' ? 'Video' : 'General'}
            </button>
          ))}
        </nav>
        <div className={styles.content}>
          {tab === 'audio' && (
            <>
              <DeviceSelect
                label="Microphone"
                devices={devices.audioinput}
                value={local.micTrack?.getSettings().deviceId ?? storage.device('audioinput')}
                onChange={(id) => void controller.switchDevice('audioinput', id)}
              />
              <div className={styles.meter} aria-label="Microphone level">
                <span style={{ width: `${Math.round(level * 100)}%` }} />
              </div>
              {canPickSpeaker && (
                <div className={styles.speakerRow}>
                  <DeviceSelect
                    label="Speakers"
                    devices={devices.audiooutput}
                    value={speakerId ?? storage.device('audiooutput')}
                    onChange={(id) => void controller.switchDevice('audiooutput', id)}
                  />
                  <button type="button" className={styles.test} onClick={() => void playTestSound(speakerId)}>
                    Test
                  </button>
                </div>
              )}
              <Switch
                checked={noise}
                onChange={(v) => {
                  setNoise(v)
                  void controller.setNoiseSuppression(v)
                }}
                label="Noise suppression"
                description="Filters out background sound like typing and fans."
              />
            </>
          )}
          {tab === 'video' && (
            <>
              <DeviceSelect
                label="Camera"
                devices={devices.videoinput}
                value={local.cameraTrack?.getSettings().deviceId ?? storage.device('videoinput')}
                onChange={(id) => void controller.switchDevice('videoinput', id)}
              />
              <div className={styles.preview}>
                {local.cameraOn && local.cameraTrack ? (
                  <VideoView track={local.cameraTrack} mirrored={mirror} />
                ) : (
                  <span>Camera is off</span>
                )}
              </div>
              <Switch
                checked={mirror}
                onChange={(v) => {
                  setMirror(v)
                  storage.setBool('mirror', v)
                }}
                label="Mirror my video"
                description="Only you see your video mirrored; everyone else sees it the right way round."
              />
            </>
          )}
          {tab === 'general' && (
            <dl className={styles.shortcuts}>
              {[
                ['Turn microphone on or off', 'Ctrl / ⌘ + D'],
                ['Turn camera on or off', 'Ctrl / ⌘ + E'],
                ['Raise or lower hand', 'Ctrl / ⌘ + Alt + H'],
                ['Open chat', 'Ctrl / ⌘ + Alt + C'],
                ['Open people', 'Ctrl / ⌘ + Alt + P'],
                ['Talk while muted', 'Hold Space'],
              ].map(([what, keys]) => (
                <div key={what}>
                  <dt>{what}</dt>
                  <dd>
                    <kbd>{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </Dialog>
  )
}
