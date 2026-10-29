import { avatarColor, cx, initials } from '../../lib/format'
import styles from './Avatar.module.css'

interface AvatarProps {
  id: string
  name: string
  size?: number
  className?: string
}

export function Avatar({ id, name, size = 40, className }: AvatarProps) {
  return (
    <span
      className={cx(styles.avatar, className)}
      style={{ width: size, height: size, fontSize: Math.max(11, size * 0.4), background: avatarColor(id) }}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}
