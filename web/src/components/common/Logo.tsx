import { Link } from 'react-router-dom'
import styles from './Logo.module.css'

export function Logo({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className={styles.logo} aria-label="Open Meet home">
      <svg viewBox="0 0 64 64" aria-hidden className={styles.mark}>
        <rect width="64" height="64" rx="16" fill="var(--color-accent)" />
        <rect x="12" y="20" width="28" height="24" rx="6" fill="#fff" />
        <path d="M42 28l10-7v22l-10-7z" fill="#fff" />
      </svg>
      <span className={styles.word}>
        Open <span className={styles.light}>Meet</span>
      </span>
    </Link>
  )
}
