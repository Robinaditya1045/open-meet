import { useEffect, useState } from 'react'
import { Toaster } from '../common/Toaster'
import type { MeetingController } from '../../meeting/controller'
import { selfParticipant, useMeeting } from '../../state/meeting'
import { AudioRenderer } from './AudioRenderer'
import { ControlBar } from './ControlBar'
import { Reactions } from './Reactions'
import { SettingsDialog } from './SettingsDialog'
import { SidePanel } from './SidePanel'
import { Stage } from './Stage'
import styles from './MeetingRoom.module.css'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

/** Keyboard shortcuts, plus holding Space to talk while muted. */
function useShortcuts(controller: MeetingController) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && !e.altKey && key === 'd') {
        e.preventDefault()
        void controller.toggleMic()
      } else if (mod && !e.altKey && key === 'e') {
        e.preventDefault()
        void controller.toggleCamera()
      } else if (mod && e.altKey && (key === 'h' || e.code === 'KeyH')) {
        e.preventDefault()
        const s = useMeeting.getState()
        controller.setHand(!((selfParticipant(s)?.hand_raised_at ?? 0) > 0))
      } else if (mod && e.altKey && (key === 'c' || e.code === 'KeyC')) {
        e.preventDefault()
        controller.openPanel('chat')
      } else if (mod && e.altKey && (key === 'p' || e.code === 'KeyP')) {
        e.preventDefault()
        controller.openPanel('people')
      } else if (e.code === 'Space' && !e.repeat && !mod && !isTyping(e.target) && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        controller.holdToTalk(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') controller.holdToTalk(false)
    }
    const onBlur = () => controller.holdToTalk(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [controller])
}

function ConnectionBanner() {
  const socket = useMeeting((s) => s.socket)
  const media = useMeeting((s) => s.media)
  let message: string | null = null
  if (socket === 'reconnecting') message = 'You lost your network connection. Trying to reconnect…'
  else if (media === 'failed' || media === 'disconnected') message = 'Your media connection was interrupted. Reconnecting…'
  if (!message) return null
  return (
    <div className={styles.banner} role="status">
      <span className={styles.bannerSpinner} aria-hidden />
      {message}
    </div>
  )
}

export function MeetingRoom({ controller }: { controller: MeetingController }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  useShortcuts(controller)

  return (
    <div className={styles.room} data-surface="call">
      <div className={styles.main}>
        <div className={styles.stageWrap}>
          <Stage controller={controller} />
          <Reactions />
        </div>
        <SidePanel controller={controller} />
      </div>
      <ControlBar controller={controller} onOpenSettings={() => setSettingsOpen(true)} />
      <ConnectionBanner />
      <AudioRenderer />
      <Toaster inCall />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} controller={controller} />
    </div>
  )
}
