import { Hand, MicOff, MonitorUp, MoreVertical, Pin, PinOff, UserMinus, WifiOff } from 'lucide-react'
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { cx } from '../../lib/format'
import type { Participant } from '../../lib/protocol'
import type { MeetingController } from '../../meeting/controller'
import { isHost, useLevels, useMeeting } from '../../state/meeting'
import { Avatar } from '../common/Avatar'
import { IconButton } from '../common/IconButton'
import { Menu, MenuItem } from '../common/Menu'
import { LevelDots } from '../media/LevelDots'
import { VideoView } from '../media/VideoView'
import { storage } from '../../lib/storage'
import styles from './Tile.module.css'

export interface TileSpec {
  /** The SFU track name this tile shows: "camera.<id>" or "screen.<id>". */
  id: string
  kind: 'camera' | 'screen'
  participant: Participant
  self: boolean
}

interface TileProps {
  spec: TileSpec
  controller: MeetingController
  style?: CSSProperties
  variant?: 'grid' | 'spotlight' | 'strip' | 'pip'
}

const SPEAKING = 0.14

export const Tile = memo(function Tile({ spec, controller, style, variant = 'grid' }: TileProps) {
  const { participant: p, kind, self } = spec
  const ref = useRef<HTMLDivElement>(null)
  const remoteTrack = useMeeting((s) => (self ? null : (s.remote[spec.id] ?? null)))
  const localTrack = useMeeting((s) => (!self ? null : kind === 'camera' ? s.local.cameraTrack : s.local.screenTrack))
  const localCameraOn = useMeeting((s) => s.local.cameraOn)
  const localMicOn = useMeeting((s) => s.local.micOn)
  const pinned = useMeeting((s) => s.pinned === spec.id)
  const amHost = useMeeting(isHost)
  const poorNetwork = useMeeting((s) => self && kind === 'camera' && s.network === 'poor')
  const level = useLevels((s) => (kind === 'camera' ? (s.levels[p.id] ?? 0) : 0))
  const [hasFrames, setHasFrames] = useState(false)

  const track = self ? localTrack : remoteTrack
  const videoOn = kind === 'screen' ? true : self ? localCameraOn : p.video_on
  const muted = self ? !localMicOn : p.audio_muted
  const speaking = kind === 'camera' && !muted && level > SPEAKING
  const showVideo = videoOn && !!track && !(self && kind === 'screen')
  const name = self ? 'You' : p.name

  // Remote tiles tell the controller how big they are, which decides the
  // simulcast layer the SFU sends them. Gone or off-screen tiles report zero.
  useEffect(() => {
    if (self) return
    const el = ref.current
    if (!el) return
    const report = () => {
      const h = el.getBoundingClientRect().height
      controller.reportTile(spec.id, Math.round(h * Math.min(window.devicePixelRatio || 1, 2)))
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => {
      observer.disconnect()
      controller.reportTile(spec.id, 0)
    }
  }, [controller, spec.id, self])

  const avatarSize = Math.round(Math.min(((style?.height as number) || 200) * 0.36, 128))

  return (
    <div
      ref={ref}
      className={cx(styles.tile, styles[variant], speaking && styles.speaking, kind === 'screen' && styles.screen)}
      style={style}
      data-tile={spec.id}
    >
      {showVideo && (
        <VideoView
          track={track}
          mirrored={self && kind === 'camera' && storage.bool('mirror', true)}
          fit={kind === 'screen' ? 'contain' : 'cover'}
          onFrames={setHasFrames}
        />
      )}

      {kind === 'screen' && self ? (
        <div className={styles.presenting}>
          <MonitorUp aria-hidden />
          <span>You&apos;re presenting to everyone</span>
          <button type="button" onClick={() => void controller.stopScreenShare()}>
            Stop presenting
          </button>
        </div>
      ) : (
        (!showVideo || !hasFrames) && (
          <div className={styles.placeholder}>
            {kind === 'screen' ? (
              <span className={styles.loading}>Loading presentation…</span>
            ) : (
              <span className={cx(styles.avatarWrap, speaking && styles.avatarSpeaking)}>
                <Avatar id={p.id} name={p.name} size={Math.max(36, avatarSize)} />
              </span>
            )}
          </div>
        )
      )}

      <div className={styles.topLeft}>
        {p.hand_raised_at > 0 && kind === 'camera' && (
          <span className={styles.hand} title="Hand raised">
            <Hand aria-hidden />
          </span>
        )}
        {poorNetwork && (
          <span className={styles.network} title="Your network connection is unstable">
            <WifiOff aria-hidden />
          </span>
        )}
      </div>

      {kind === 'camera' && (
        <div className={styles.topRight}>
          {muted ? (
            <span className={styles.muted} aria-label="Microphone off">
              <MicOff aria-hidden />
            </span>
          ) : (
            <LevelDots level={level} className={cx(styles.levelDots, !speaking && styles.quiet)} />
          )}
        </div>
      )}

      <div className={styles.label}>
        {pinned && <Pin aria-hidden className={styles.pinIcon} />}
        {kind === 'screen' && <MonitorUp aria-hidden className={styles.pinIcon} />}
        <span>{kind === 'screen' ? `${name} (presentation)` : name}</span>
      </div>

      {!p.connected && (
        <div className={styles.reconnecting}>
          <span className={styles.spinner} aria-hidden />
          Reconnecting…
        </div>
      )}

      {variant !== 'pip' && (
        <div className={styles.actions}>
          <IconButton
            variant="overlay"
            size="sm"
            label={pinned ? 'Unpin' : 'Pin to the main screen'}
            icon={pinned ? <PinOff /> : <Pin />}
            onClick={() => controller.pin(spec.id)}
          />
          {!self && amHost && kind === 'camera' && (
            <Menu
              dark
              side="bottom"
              align="end"
              trigger={<IconButton variant="overlay" size="sm" label={`More options for ${p.name}`} icon={<MoreVertical />} />}
            >
              <MenuItem icon={<MicOff />} disabled={p.audio_muted} onSelect={() => controller.mute(p.id)}>
                Mute {p.name}
              </MenuItem>
              <MenuItem icon={<UserMinus />} danger onSelect={() => controller.remove(p.id)}>
                Remove from the call
              </MenuItem>
            </Menu>
          )}
        </div>
      )}
    </div>
  )
})

/** The last grid tile when more people are in the call than fit. */
export function OverflowTile({ people, style }: { people: Participant[]; style?: CSSProperties }) {
  return (
    <div className={cx(styles.tile, styles.overflow)} style={style}>
      <div className={styles.overflowFaces}>
        {people.slice(0, 3).map((p) => (
          <Avatar key={p.id} id={p.id} name={p.name} size={44} className={styles.overflowAvatar} />
        ))}
      </div>
      <span className={styles.overflowCount}>
        {people.length} {people.length === 1 ? 'other' : 'others'}
      </span>
    </div>
  )
}
