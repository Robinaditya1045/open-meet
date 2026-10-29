import { cx } from '../../lib/format'
import styles from './LevelDots.module.css'

/** Three bars that move with a speaker's level — the "is talking" indicator. */
export function LevelDots({ level, className }: { level: number; className?: string }) {
  const l = Math.max(0, Math.min(1, level))
  const heights = [0.35 + l * 0.45, 0.35 + l, 0.35 + l * 0.45]
  return (
    <span className={cx(styles.dots, l > 0.08 && styles.active, className)} aria-hidden>
      {heights.map((h, i) => (
        <span key={i} style={{ transform: `scaleY(${Math.min(1, h)})` }} />
      ))}
    </span>
  )
}
