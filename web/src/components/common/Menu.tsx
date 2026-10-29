import * as Dropdown from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../../lib/format'
import styles from './Menu.module.css'

interface MenuProps {
  trigger: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** Renders inside the call's dark surface. */
  dark?: boolean
  className?: string
}

/** A dropdown menu, portalled so no scroller or tile can clip it. */
export function Menu({ trigger, children, side = 'top', align = 'center', dark, className }: MenuProps) {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          className={cx(styles.content, className)}
          data-surface={dark ? 'call' : undefined}
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
        >
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}

interface MenuItemProps {
  icon?: ReactNode
  children: ReactNode
  onSelect?: () => void
  danger?: boolean
  checked?: boolean
  disabled?: boolean
}

export function MenuItem({ icon, children, onSelect, danger, checked, disabled }: MenuItemProps) {
  return (
    <Dropdown.Item
      className={cx(styles.item, danger && styles.danger)}
      onSelect={onSelect}
      disabled={disabled}
    >
      <span className={styles.icon}>{checked ? <Check /> : icon}</span>
      <span className={styles.label}>{children}</span>
    </Dropdown.Item>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Dropdown.Label className={styles.menuLabel}>{children}</Dropdown.Label>
}

export function MenuSeparator() {
  return <Dropdown.Separator className={styles.separator} />
}
