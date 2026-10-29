import { useMeeting } from '../../state/meeting'
import styles from './Reactions.module.css'

/** Reactions float up from the bottom-left corner of the stage and fade out. */
export function Reactions() {
  const reactions = useMeeting((s) => s.reactions)
  return (
    <div className={styles.layer} aria-live="polite">
      {reactions.map((r) => (
        <div key={r.id} className={styles.reaction} style={{ left: `${4 + r.lane * 22}%` }}>
          <span className={styles.emoji}>{r.emoji}</span>
          {r.name && <span className={styles.name}>{r.name}</span>}
        </div>
      ))}
    </div>
  )
}
