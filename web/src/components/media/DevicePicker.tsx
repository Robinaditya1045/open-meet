import { ChevronDown, Mic, Video, Volume2 } from 'lucide-react'
import type { DeviceKind } from '../../lib/rtc/devices'
import { Menu, MenuItem, MenuLabel } from '../common/Menu'
import styles from './DevicePicker.module.css'

const ICONS: Record<DeviceKind, typeof Mic> = { audioinput: Mic, audiooutput: Volume2, videoinput: Video }
const TITLES: Record<DeviceKind, string> = {
  audioinput: 'Microphone',
  audiooutput: 'Speakers',
  videoinput: 'Camera',
}

interface DevicePickerProps {
  kind: DeviceKind
  devices: MediaDeviceInfo[]
  selected: string | null
  onSelect: (deviceId: string) => void
  dark?: boolean
  /** Renders as a chip with the device name instead of just a caret. */
  chip?: boolean
}

function label(d: MediaDeviceInfo, i: number, kind: DeviceKind) {
  return d.label || `${TITLES[kind]} ${i + 1}`
}

export function DevicePicker({ kind, devices, selected, onSelect, dark, chip = true }: DevicePickerProps) {
  const Icon = ICONS[kind]
  const current = devices.find((d) => d.deviceId === selected) ?? devices.find((d) => d.deviceId === 'default') ?? devices[0]
  const currentLabel = current ? label(current, devices.indexOf(current), kind) : `No ${TITLES[kind].toLowerCase()} found`
  return (
    <Menu
      dark={dark}
      side={chip ? 'bottom' : 'top'}
      align={chip ? 'start' : 'center'}
      trigger={
        chip ? (
          <button type="button" className={styles.chip} disabled={devices.length === 0} aria-label={`${TITLES[kind]}: ${currentLabel}`}>
            <Icon aria-hidden />
            <span className={styles.chipLabel}>{currentLabel}</span>
            <ChevronDown aria-hidden className={styles.caret} />
          </button>
        ) : (
          <button type="button" className={styles.caretButton} aria-label={`Choose ${TITLES[kind].toLowerCase()}`}>
            <ChevronDown aria-hidden />
          </button>
        )
      }
    >
      <MenuLabel>{TITLES[kind]}</MenuLabel>
      {devices.length === 0 && <MenuItem disabled>No devices found</MenuItem>}
      {devices.map((d, i) => (
        <MenuItem key={d.deviceId} checked={d.deviceId === current?.deviceId} onSelect={() => onSelect(d.deviceId)}>
          {label(d, i, kind)}
        </MenuItem>
      ))}
    </Menu>
  )
}
