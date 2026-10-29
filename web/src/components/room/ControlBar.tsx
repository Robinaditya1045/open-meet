import * as Dropdown from '@radix-ui/react-dropdown-menu'
import {
  Hand,
  Info,
  Maximize,
  MessageSquareText,
  Mic,
  MicOff,
  Minimize,
  MonitorUp,
  MonitorX,
  MoreVertical,
  PhoneOff,
  Settings as SettingsIcon,
  Shield,
  SmilePlus,
  Users,
  Video,
  VideoOff,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useClock, useDevices, useMediaQuery } from '../../hooks/useMisc'
import { clockTime, cx } from '../../lib/format'
import { REACTIONS } from '../../lib/protocol'
import { canShareScreen } from '../../lib/rtc/devices'
import { storage } from '../../lib/storage'
import type { MeetingController } from '../../meeting/controller'
import { isHost, selfParticipant, useMeeting } from '../../state/meeting'
import { IconButton } from '../common/IconButton'
import { Menu, MenuItem, MenuSeparator } from '../common/Menu'
import { Tooltip } from '../common/Tooltip'
import { DevicePicker } from '../media/DevicePicker'
import styles from './ControlBar.module.css'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl'

interface ControlBarProps {
  controller: MeetingController
  onOpenSettings: () => void
}

export function ControlBar({ controller, onOpenSettings }: ControlBarProps) {
  const now = useClock()
  const compact = useMediaQuery('(max-width: 720px)')
  const code = useMeeting((s) => s.code)
  const local = useMeeting((s) => s.local)
  const panel = useMeeting((s) => s.panel)
  const unread = useMeeting((s) => s.unread)
  const count = useMeeting((s) => s.participants.length)
  const lobby = useMeeting((s) => s.lobby.length)
  const host = useMeeting(isHost)
  const settings = useMeeting((s) => s.settings)
  const handRaised = useMeeting((s) => (selfParticipant(s)?.hand_raised_at ?? 0) > 0)
  const devices = useDevices(`${local.micTrack?.id}-${local.cameraTrack?.id}`)
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement)

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const canPresent = host || settings.screen_share_enabled
  const canReact = host || settings.reactions_enabled
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen?.().catch(() => {})
  }

  const presentButton = (
    <IconButton
      variant="control"
      tone={local.sharing ? 'active' : 'default'}
      label={local.sharing ? 'Stop presenting' : canPresent ? 'Present now' : 'The host turned off presenting'}
      icon={local.sharing ? <MonitorX /> : <MonitorUp />}
      disabled={!canPresent && !local.sharing}
      onClick={() => void (local.sharing ? controller.stopScreenShare() : controller.startScreenShare())}
    />
  )

  return (
    <footer className={styles.bar}>
      <div className={styles.left}>
        <span className={styles.time}>{clockTime(now)}</span>
        <span className={styles.divider} aria-hidden />
        <span className={styles.code}>{code}</span>
      </div>

      <div className={styles.center}>
        <div className={cx(styles.split, !local.micOn && styles.splitOff)}>
          {!compact && (
            <DevicePicker
              kind="audioinput"
              chip={false}
              dark
              devices={devices.audioinput}
              selected={local.micTrack?.getSettings().deviceId ?? storage.device('audioinput')}
              onSelect={(id) => void controller.switchDevice('audioinput', id)}
            />
          )}
          <IconButton
            variant="control"
            tone={local.micOn ? 'default' : 'off'}
            label={local.micOn ? 'Turn off microphone' : 'Turn on microphone'}
            shortcut={`${mod} + D`}
            icon={local.micOn ? <Mic /> : <MicOff />}
            onClick={() => void controller.toggleMic()}
          />
        </div>
        <div className={cx(styles.split, !local.cameraOn && styles.splitOff)}>
          {!compact && (
            <DevicePicker
              kind="videoinput"
              chip={false}
              dark
              devices={devices.videoinput}
              selected={local.cameraTrack?.getSettings().deviceId ?? storage.device('videoinput')}
              onSelect={(id) => void controller.switchDevice('videoinput', id)}
            />
          )}
          <IconButton
            variant="control"
            tone={local.cameraOn ? 'default' : 'off'}
            label={local.cameraOn ? 'Turn off camera' : 'Turn on camera'}
            shortcut={`${mod} + E`}
            icon={local.cameraOn ? <Video /> : <VideoOff />}
            onClick={() => void controller.toggleCamera()}
          />
        </div>

        {!compact && canReact && <ReactionPicker controller={controller} />}
        {!compact && canShareScreen && presentButton}
        <IconButton
          variant="control"
          tone={handRaised ? 'active' : 'default'}
          label={handRaised ? 'Lower hand' : 'Raise hand'}
          shortcut={`${mod} + Alt + H`}
          icon={<Hand />}
          onClick={() => controller.setHand(!handRaised)}
        />

        <Menu dark trigger={<IconButton variant="control" label="More options" icon={<MoreVertical />} />}>
          {compact && canReact && (
            <div className={styles.menuReactions}>
              {REACTIONS.map((e) => (
                <Dropdown.Item key={e} className={styles.emoji} onSelect={() => controller.react(e)} aria-label={`Send ${e}`}>
                  {e}
                </Dropdown.Item>
              ))}
            </div>
          )}
          {compact && (
            <>
              {canShareScreen && (
                <MenuItem
                  icon={local.sharing ? <MonitorX /> : <MonitorUp />}
                  disabled={!canPresent && !local.sharing}
                  onSelect={() => void (local.sharing ? controller.stopScreenShare() : controller.startScreenShare())}
                >
                  {local.sharing ? 'Stop presenting' : 'Present now'}
                </MenuItem>
              )}
              <MenuItem icon={<Users />} onSelect={() => controller.openPanel('people')}>
                People ({count})
              </MenuItem>
              <MenuItem icon={<MessageSquareText />} onSelect={() => controller.openPanel('chat')}>
                In-call messages{unread > 0 ? ` (${unread})` : ''}
              </MenuItem>
              <MenuItem icon={<Info />} onSelect={() => controller.openPanel('info')}>
                Meeting details
              </MenuItem>
              {host && (
                <MenuItem icon={<Shield />} onSelect={() => controller.openPanel('host')}>
                  Host controls
                </MenuItem>
              )}
              <MenuSeparator />
            </>
          )}
          <MenuItem icon={fullscreen ? <Minimize /> : <Maximize />} onSelect={toggleFullscreen}>
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </MenuItem>
          <MenuItem icon={<SettingsIcon />} onSelect={onOpenSettings}>
            Settings
          </MenuItem>
        </Menu>

        {host ? (
          <Menu
            dark
            trigger={<IconButton variant="control" tone="danger" label="Leave call" icon={<PhoneOff />} />}
          >
            <MenuItem icon={<PhoneOff />} onSelect={() => controller.leave()}>
              Just leave the call
            </MenuItem>
            <MenuItem icon={<Users />} danger onSelect={() => controller.endForEveryone()}>
              End the call for everyone
            </MenuItem>
          </Menu>
        ) : (
          <IconButton
            variant="control"
            tone="danger"
            label="Leave call"
            icon={<PhoneOff />}
            onClick={() => controller.leave()}
          />
        )}
      </div>

      <div className={styles.right}>
        <IconButton
          label="Meeting details"
          icon={<Info />}
          tone={panel === 'info' ? 'active' : 'default'}
          onClick={() => controller.openPanel('info')}
        />
        <IconButton
          label="People"
          shortcut={`${mod} + Alt + P`}
          icon={<Users />}
          tone={panel === 'people' ? 'active' : 'default'}
          badge={host && lobby > 0 ? lobby : count}
          onClick={() => controller.openPanel('people')}
        />
        <IconButton
          label="Chat with everyone"
          shortcut={`${mod} + Alt + C`}
          icon={<MessageSquareText />}
          tone={panel === 'chat' ? 'active' : 'default'}
          badge={unread > 0 ? unread : undefined}
          onClick={() => controller.openPanel('chat')}
        />
        {host && (
          <IconButton
            label="Host controls"
            icon={<Shield />}
            tone={panel === 'host' ? 'active' : 'default'}
            onClick={() => controller.openPanel('host')}
          />
        )}
      </div>
    </footer>
  )
}

function ReactionPicker({ controller }: { controller: MeetingController }) {
  return (
    <Dropdown.Root modal={false}>
      <Tooltip label="Send a reaction">
        <Dropdown.Trigger asChild>
          <IconButton variant="control" label="Send a reaction" icon={<SmilePlus />} hideTooltip />
        </Dropdown.Trigger>
      </Tooltip>
      <Dropdown.Portal>
        <Dropdown.Content className={styles.reactions} side="top" sideOffset={10} data-surface="call">
          {REACTIONS.map((e) => (
            <Dropdown.Item
              key={e}
              className={styles.emoji}
              aria-label={`Send ${e}`}
              onSelect={(ev) => {
                // Keep the picker open for a burst of reactions.
                ev.preventDefault()
                controller.react(e)
              }}
            >
              {e}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}
