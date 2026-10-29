import { Check, Copy, X } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useElementSize } from '../../hooks/useElementSize'
import { useMediaQuery } from '../../hooks/useMisc'
import { meetingLink } from '../../lib/api'
import { fitGrid, gridCapacity, pickVisible, tileAspect } from '../../lib/layout'
import type { MeetingController } from '../../meeting/controller'
import { useMeeting } from '../../state/meeting'
import { OverflowTile, Tile, type TileSpec } from './Tile'
import styles from './Stage.module.css'

const GAP = 8

export function Stage({ controller }: { controller: MeetingController }) {
  const ref = useRef<HTMLDivElement>(null)
  const size = useElementSize(ref)
  const participants = useMeeting((s) => s.participants)
  const selfId = useMeeting((s) => s.selfId)
  const pinned = useMeeting((s) => s.pinned)
  const recentSpeakers = useMeeting((s) => s.recentSpeakers)
  const sharing = useMeeting((s) => s.local.sharing)
  const compact = useMediaQuery('(max-width: 720px)')

  const recent = useMemo(() => recentSpeakers.map((id) => `camera.${id}`), [recentSpeakers])

  const people: TileSpec[] = useMemo(
    () => participants.map((p) => ({ id: `camera.${p.id}`, kind: 'camera', participant: p, self: p.id === selfId })),
    [participants, selfId],
  )
  const presentations: TileSpec[] = useMemo(
    () =>
      participants
        .filter((p) => (p.id === selfId ? sharing : p.screen_sharing))
        .map((p) => ({ id: `screen.${p.id}`, kind: 'screen', participant: p, self: p.id === selfId })),
    [participants, selfId, sharing],
  )

  // A pinned tile wins; otherwise the newest presentation, preferring someone
  // else's over your own (you already know what is on your screen).
  const focus =
    [...people, ...presentations].find((t) => t.id === pinned) ??
    [...presentations].reverse().find((t) => !t.self) ??
    presentations[presentations.length - 1] ??
    null

  const { width, height } = size
  let content: ReactNode = null

  if (width > 0 && height > 0) {
    if (focus) {
      const others = [...presentations, ...people].filter((t) => t.id !== focus.id)
      const vertical = !compact && width > height * 1.1
      const stripTileW = vertical ? Math.min(260, Math.max(160, width * 0.2)) : 0
      const stripTileH = vertical ? Math.round((stripTileW * 9) / 16) : compact ? 96 : 120
      const stripTileWHorizontal = Math.round((stripTileH * 16) / 9)
      const mainW = vertical ? width - (others.length ? stripTileW + GAP : 0) : width
      const mainH = vertical ? height : height - (others.length ? stripTileH + GAP : 0)
      const slots = vertical
        ? Math.max(1, Math.floor((height + GAP) / (stripTileH + GAP)))
        : Math.max(1, Math.floor((width + GAP) / (stripTileWHorizontal + GAP)))
      const { visible, hidden } = pickVisible(
        others.map((t) => ({ ...t, joinedAt: t.participant.joined_at, handRaisedAt: t.participant.hand_raised_at })),
        others.length > slots ? slots - 1 : slots,
        recent,
      )
      const tileStyle = vertical
        ? { width: stripTileW, height: stripTileH }
        : { width: stripTileWHorizontal, height: stripTileH }
      // A presentation fills the area (letterboxed inside its own tile); a
      // camera keeps the shape cameras have.
      const mainFit = focus.kind === 'camera' ? fitGrid(mainW, mainH, 1, 0, 16 / 9) : { width: mainW, height: mainH }
      content = (
        <div className={vertical ? styles.spotlightRow : styles.spotlightColumn}>
          <div className={styles.main} style={{ width: mainW, height: mainH }}>
            <Tile
              spec={focus}
              controller={controller}
              variant="spotlight"
              style={{ width: mainFit.width, height: mainFit.height }}
            />
          </div>
          {others.length > 0 && (
            <div className={vertical ? styles.stripVertical : styles.stripHorizontal}>
              {visible.map((t) => (
                <Tile key={t.id} spec={t} controller={controller} variant="strip" style={tileStyle} />
              ))}
              {hidden.length > 0 && <OverflowTile people={hidden.map((t) => t.participant)} style={tileStyle} />}
            </div>
          )}
        </div>
      )
    } else if (people.length === 2 && people.some((p) => p.self)) {
      const other = people.find((p) => !p.self)!
      const self = people.find((p) => p.self)!
      const pipW = compact ? Math.round(width * 0.32) : Math.min(280, Math.round(width * 0.24))
      const pipH = compact && height > width ? Math.round(pipW * 1.33) : Math.round((pipW * 9) / 16)
      const mainFit = fitGrid(width, height, 1, 0, tileAspect(width, height, 1))
      content = (
        <div className={styles.duo}>
          <Tile
            spec={other}
            controller={controller}
            variant="spotlight"
            style={{ width: mainFit.width, height: mainFit.height }}
          />
          <div className={styles.pip}>
            <Tile spec={self} controller={controller} variant="pip" style={{ width: pipW, height: pipH }} />
          </div>
        </div>
      )
    } else {
      const minTileW = compact ? 120 : 200
      const capacity = gridCapacity(width, height, GAP, minTileW, 49)
      const { visible, hidden } = pickVisible(
        people.map((t) => ({ ...t, joinedAt: t.participant.joined_at, handRaisedAt: t.participant.hand_raised_at })),
        people.length > capacity ? capacity - 1 : capacity,
        recent,
      )
      const n = visible.length + (hidden.length > 0 ? 1 : 0)
      const fit = fitGrid(width, height, n, GAP, tileAspect(width, height, n))
      const tileStyle = { width: fit.width, height: fit.height }
      content = (
        <div className={styles.grid} style={{ maxWidth: fit.cols * fit.width + (fit.cols - 1) * GAP + 1 }}>
          {visible.map((t) => (
            <Tile key={t.id} spec={t} controller={controller} style={tileStyle} />
          ))}
          {hidden.length > 0 && <OverflowTile people={hidden.map((t) => t.participant)} style={tileStyle} />}
        </div>
      )
    }
  }

  return (
    <div ref={ref} className={styles.stage}>
      {content}
      {participants.length === 1 && <InviteCard code={controller.code} />}
    </div>
  )
}

/** Shown while you're alone in the call: the link to send people. */
function InviteCard({ code }: { code: string }) {
  const [dismissed, setDismissed] = useState(false)
  const [copied, setCopied] = useState(false)
  if (dismissed) return null
  const link = meetingLink(code)
  return (
    <div className={styles.invite} role="dialog" aria-label="Your meeting's ready">
      <div className={styles.inviteHeader}>
        <h2>Your meeting&apos;s ready</h2>
        <button type="button" aria-label="Close" onClick={() => setDismissed(true)}>
          <X />
        </button>
      </div>
      <p>Share this joining info with people you want in the meeting.</p>
      <div className={styles.inviteLink}>
        <span>{link.replace(/^https?:\/\//, '')}</span>
        <button
          type="button"
          aria-label="Copy joining info"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(link)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              })
              .catch(() => {})
          }}
        >
          {copied ? <Check /> : <Copy />}
        </button>
      </div>
    </div>
  )
}
