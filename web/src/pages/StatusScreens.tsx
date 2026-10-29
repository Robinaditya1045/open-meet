import { useNavigate } from 'react-router-dom'
import { Button } from '../components/common/Button'
import { Logo } from '../components/common/Logo'
import { VideoView } from '../components/media/VideoView'
import type { Phase } from '../state/meeting'
import { useMeeting } from '../state/meeting'
import styles from './StatusScreens.module.css'

const ENDINGS: Record<string, { title: string; body: (by: string | null) => string; rejoin: boolean }> = {
  left: { title: 'You left the meeting', body: () => 'Have a nice day!', rejoin: true },
  ended: {
    title: 'The meeting has ended',
    body: (by) => (by ? `${by} ended the call for everyone.` : 'The host ended the call for everyone.'),
    rejoin: true,
  },
  removed: {
    title: "You've been removed from the meeting",
    body: (by) => (by ? `${by} removed you from the call.` : 'A host removed you from the call.'),
    rejoin: true,
  },
  denied: { title: "You can't join this call", body: () => 'Someone in the call denied your request to join.', rejoin: false },
  not_found: {
    title: 'Check your meeting code',
    body: () => "Make sure you entered the correct meeting code in the URL. Codes look like abc-defg-hjk.",
    rejoin: false,
  },
  full: { title: 'This meeting is full', body: () => 'No more people can join right now.', rejoin: true },
  replaced: {
    title: 'You joined from another window',
    body: () => 'This window was disconnected because the call continued somewhere else.',
    rejoin: true,
  },
  lost: { title: 'You lost your network connection', body: () => 'Trying to rejoin when your connection is back.', rejoin: true },
}

export function EndScreen({ phase, by, onRejoin }: { phase: Phase; by: string | null; onRejoin: () => void }) {
  const navigate = useNavigate()
  const ending = ENDINGS[phase] ?? ENDINGS.left
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Logo />
      </header>
      <main className={styles.end}>
        <h1>{ending.title}</h1>
        <p>{ending.body(by)}</p>
        <div className={styles.buttons}>
          {ending.rejoin && (
            <Button variant="outline" size="lg" onClick={onRejoin}>
              Rejoin
            </Button>
          )}
          <Button size="lg" onClick={() => navigate('/')}>
            Return to home screen
          </Button>
        </div>
      </main>
    </div>
  )
}

export function WaitingRoom({ onCancel }: { onCancel: () => void }) {
  const phase = useMeeting((s) => s.phase)
  const local = useMeeting((s) => s.local)
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Logo />
      </header>
      <main className={styles.waiting}>
        <div className={styles.preview} data-surface="call">
          {local.cameraOn && local.cameraTrack ? (
            <VideoView track={local.cameraTrack} mirrored />
          ) : (
            <div className={styles.cameraOff}>Camera is off</div>
          )}
        </div>
        <div className={styles.waitingText}>
          <span className={styles.spinner} aria-hidden />
          <h1>{phase === 'waiting' ? 'Asking to be let in…' : 'Joining…'}</h1>
          <p>
            {phase === 'waiting'
              ? "You'll join the call when someone lets you in."
              : 'Connecting you to the meeting.'}
          </p>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </main>
    </div>
  )
}
