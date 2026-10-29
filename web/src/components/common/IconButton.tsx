import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../lib/format'
import { Tooltip } from './Tooltip'
import styles from './IconButton.module.css'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  /** Shortcut shown in the tooltip, such as "Ctrl + D". */
  shortcut?: string
  icon: ReactNode
  /**
   * control: the call bar's round buttons. off renders the red "you are muted"
   * state, active the highlighted "this is on" state.
   * ghost: flat icon buttons in panels and tiles.
   */
  variant?: 'control' | 'ghost' | 'overlay'
  tone?: 'default' | 'off' | 'active' | 'danger'
  size?: 'sm' | 'md'
  badge?: ReactNode
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
  hideTooltip?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    shortcut,
    icon,
    variant = 'ghost',
    tone = 'default',
    size = 'md',
    badge,
    className,
    tooltipSide,
    hideTooltip,
    type = 'button',
    ...rest
  },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx(styles.button, styles[variant], styles[tone], styles[size], className)}
      {...rest}
    >
      {icon}
      {badge !== undefined && badge !== null && badge !== false && <span className={styles.badge}>{badge}</span>}
    </button>
  )
  if (hideTooltip) return button
  return (
    <Tooltip
      side={tooltipSide}
      label={
        shortcut ? (
          <>
            {label} <span className={styles.shortcut}>({shortcut})</span>
          </>
        ) : (
          label
        )
      }
    >
      {button}
    </Tooltip>
  )
})
