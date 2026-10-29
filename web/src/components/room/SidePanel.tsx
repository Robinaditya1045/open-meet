import {
  Check,
  Copy,
  Crown,
  Hand,
  Lock,
  MessageSquareText,
  Mic,
  MicOff,
  MonitorUp,
  MoreVertical,
  Pin,
  Search,
  SendHorizontal,
  ShieldCheck,
  SmilePlus,
  UserMinus,
  X,
} from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { meetingLink } from '../../lib/api'
import { cx, messageTime } from '../../lib/format'
import type { ChatMessage, Participant } from '../../lib/protocol'
import { storage } from '../../lib/storage'
import type { MeetingController } from '../../meeting/controller'
import { isHost, useLevels, useMeeting, type Panel } from '../../state/meeting'
import { Avatar } from '../common/Avatar'
import { Button } from '../common/Button'
import { IconButton } from '../common/IconButton'
import { Menu, MenuItem } from '../common/Menu'
import { Switch } from '../common/Switch'
import { LevelDots } from '../media/LevelDots'
import styles from './SidePanel.module.css'

const TITLES: Record<Exclude<Panel, null>, string> = {
  info: 'Meeting details',
  people: 'People',
  chat: 'In-call messages',
  host: 'Host controls',
}

export function SidePanel({ controller }: { controller: MeetingController }) {
  const panel = useMeeting((s) => s.panel)
  if (!panel) return null
  return (
    <aside className={styles.panel} aria-label={TITLES[panel]}>
      <header className={styles.header}>
        <h2>{TITLES[panel]}</h2>
        <IconButton label="Close" icon={<X />} onClick={() => controller.openPanel(null)} hideTooltip />
      </header>
      <div className={styles.body}>
        {panel === 'info' && <InfoPanel />}
        {panel === 'people' && <PeoplePanel controller={controller} />}
        {panel === 'chat' && <ChatPanel controller={controller} />}
        {panel === 'host' && <HostPanel controller={controller} />}
      </div>
    </aside>
  )
}

function CopyRow({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.copyRow}>
      <span className={styles.copyValue}>{value}</span>
      <IconButton
        label={copied ? 'Copied' : label}
        icon={copied ? <Check /> : <Copy />}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
            .catch(() => {})
        }}
      />
    </div>
  )
}

function InfoPanel() {
  const code = useMeeting((s) => s.code)
  const createdAt = useMeeting((s) => s.createdAt)
  const host = useMeeting(isHost)
  const hostKey = storage.hostKey(code)
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>Joining info</h3>
      <CopyRow value={meetingLink(code)} label="Copy joining info" />
      <p className={styles.hint}>Share this link with the people you want in the meeting.</p>
      <dl className={styles.facts}>
        <dt>Meeting code</dt>
        <dd className={styles.mono}>{code}</dd>
        <dt>Created</dt>
        <dd>{new Date(createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd>
      </dl>
      {host && hostKey && (
        <>
          <h3 className={styles.sectionTitle}>Host link</h3>
          <CopyRow value={`${meetingLink(code)}?host=${hostKey}`} label="Copy host link" />
          <p className={styles.hint}>Anyone who opens this link joins as a host. Share it only with co-hosts.</p>
        </>
      )}
    </div>
  )
}

function PersonLevel({ participant }: { participant: Participant }) {
  const level = useLevels((s) => s.levels[participant.id] ?? 0)
  if (participant.audio_muted) return <MicOff className={styles.mutedIcon} aria-label="Muted" />
  return level > 0.08 ? <LevelDots level={level} /> : <Mic className={styles.micIcon} aria-label="Unmuted" />
}

function PeoplePanel({ controller }: { controller: MeetingController }) {
  const participants = useMeeting((s) => s.participants)
  const lobby = useMeeting((s) => s.lobby)
  const selfId = useMeeting((s) => s.selfId)
  const host = useMeeting(isHost)
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const matches = (name: string) => !q || name.toLowerCase().includes(q)
  const hands = participants.filter((p) => p.hand_raised_at > 0).sort((a, b) => a.hand_raised_at - b.hand_raised_at)
  const people = [...participants].sort((a, b) => {
    if (a.id === selfId) return -1
    if (b.id === selfId) return 1
    return a.joined_at - b.joined_at
  })

  return (
    <div className={styles.section}>
      <label className={styles.search}>
        <Search aria-hidden />
        <span className="sr-only">Search for people</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for people" />
      </label>

      {host && participants.length > 1 && (
        <div className={styles.rowActions}>
          <Button variant="outline" size="sm" icon={<MicOff />} onClick={() => controller.muteAll()}>
            Mute all
          </Button>
        </div>
      )}

      {host && lobby.length > 0 && (
        <Group title={`Waiting to join (${lobby.length})`} action={lobby.length > 1 ? { label: 'Admit all', onClick: () => controller.admitAll() } : undefined}>
          {lobby.filter((l) => matches(l.name)).map((l) => (
            <li key={l.id} className={styles.person}>
              <Avatar id={l.id} name={l.name} size={32} />
              <span className={styles.personName}>{l.name}</span>
              <div className={styles.lobbyButtons}>
                <Button variant="ghost" size="sm" onClick={() => controller.deny(l.id)}>
                  Deny
                </Button>
                <Button variant="secondary" size="sm" onClick={() => controller.admit(l.id)}>
                  Admit
                </Button>
              </div>
            </li>
          ))}
        </Group>
      )}

      {hands.length > 0 && (
        <Group title={`Raised hands (${hands.length})`}>
          {hands.filter((p) => matches(p.name)).map((p, i) => (
            <li key={p.id} className={styles.person}>
              <span className={styles.handOrder}>
                <Hand aria-hidden />
                {i + 1}
              </span>
              <span className={styles.personName}>{p.id === selfId ? `${p.name} (You)` : p.name}</span>
              {(host || p.id === selfId) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => (p.id === selfId ? controller.setHand(false) : controller.lowerHand(p.id))}
                >
                  Lower
                </Button>
              )}
            </li>
          ))}
        </Group>
      )}

      <Group title={`In the meeting (${participants.length})`}>
        {people.filter((p) => matches(p.name)).map((p) => (
          <li key={p.id} className={styles.person}>
            <Avatar id={p.id} name={p.name} size={32} />
            <span className={styles.personText}>
              <span className={styles.personName}>
                {p.name}
                {p.id === selfId && ' (You)'}
              </span>
              <span className={styles.personMeta}>
                {p.is_host && (
                  <span className={styles.hostTag}>
                    <Crown aria-hidden /> Meeting host
                  </span>
                )}
                {p.screen_sharing && (
                  <span className={styles.metaTag}>
                    <MonitorUp aria-hidden /> Presenting
                  </span>
                )}
                {!p.connected && <span className={styles.metaTag}>Reconnecting…</span>}
              </span>
            </span>
            <span className={styles.personStatus}>
              <PersonLevel participant={p} />
            </span>
            <Menu
              dark
              side="bottom"
              align="end"
              trigger={<IconButton size="sm" label={`More actions for ${p.name}`} icon={<MoreVertical />} hideTooltip />}
            >
              <MenuItem icon={<Pin />} onSelect={() => controller.pin(`camera.${p.id}`)}>
                Pin to screen
              </MenuItem>
              {host && p.id !== selfId && (
                <>
                  <MenuItem icon={<MicOff />} disabled={p.audio_muted} onSelect={() => controller.mute(p.id)}>
                    Mute
                  </MenuItem>
                  {!p.is_host && (
                    <MenuItem icon={<ShieldCheck />} onSelect={() => controller.makeHost(p.id)}>
                      Make co-host
                    </MenuItem>
                  )}
                  {p.hand_raised_at > 0 && (
                    <MenuItem icon={<Hand />} onSelect={() => controller.lowerHand(p.id)}>
                      Lower hand
                    </MenuItem>
                  )}
                  <MenuItem icon={<UserMinus />} danger onSelect={() => controller.remove(p.id)}>
                    Remove from the call
                  </MenuItem>
                </>
              )}
            </Menu>
          </li>
        ))}
      </Group>
    </div>
  )
}

function Group({
  title,
  action,
  children,
}: {
  title: string
  action?: { label: string; onClick: () => void }
  children: ReactNode
}) {
  return (
    <section className={styles.group}>
      <div className={styles.groupHeader}>
        <h3>{title}</h3>
        {action && (
          <Button variant="ghost" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
      </div>
      <ul className={styles.people}>{children}</ul>
    </section>
  )
}

/** Splits a message into text and links, without ever rendering markup from it. */
function linkify(text: string): ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g)
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}

/** Consecutive messages from one person within two minutes share a header. */
function groupMessages(chat: ChatMessage[]) {
  const groups: { first: ChatMessage; messages: ChatMessage[] }[] = []
  for (const m of chat) {
    const last = groups[groups.length - 1]
    if (last && last.first.participant_id === m.participant_id && m.sent_at - last.messages[last.messages.length - 1].sent_at < 120_000) {
      last.messages.push(m)
    } else {
      groups.push({ first: m, messages: [m] })
    }
  }
  return groups
}

function ChatPanel({ controller }: { controller: MeetingController }) {
  const chat = useMeeting((s) => s.chat)
  const selfId = useMeeting((s) => s.selfId)
  const settings = useMeeting((s) => s.settings)
  const host = useMeeting(isHost)
  const socket = useMeeting((s) => s.socket)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)
  const groups = useMemo(() => groupMessages(chat), [chat])
  const canChat = host || settings.chat_enabled

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [chat.length])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const send = () => {
    if (!draft.trim()) return
    controller.sendChat(draft)
    setDraft('')
    stickToBottom.current = true
  }

  return (
    <div className={styles.chat}>
      <div
        ref={listRef}
        className={styles.messages}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <p className={styles.chatNotice}>
          Messages can only be seen by people in the call and are deleted when the call ends.
        </p>
        {groups.length === 0 && (
          <div className={styles.emptyChat}>
            <MessageSquareText aria-hidden />
            <span>No messages yet</span>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.first.id} className={cx(styles.messageGroup, g.first.participant_id === selfId && styles.mine)}>
            <div className={styles.messageHeader}>
              <span className={styles.messageName}>{g.first.participant_id === selfId ? 'You' : g.first.name}</span>
              <span className={styles.messageTime}>{messageTime(g.first.sent_at)}</span>
            </div>
            {g.messages.map((m) => (
              <p key={m.id} className={styles.message}>
                {linkify(m.text)}
              </p>
            ))}
          </div>
        ))}
      </div>
      {canChat ? (
        <form
          className={styles.composer}
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            maxLength={2000}
            placeholder="Send a message"
            aria-label="Send a message to everyone"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <IconButton
            type="submit"
            label="Send message"
            icon={<SendHorizontal />}
            tone={draft.trim() ? 'active' : 'default'}
            disabled={!draft.trim() || socket !== 'open'}
          />
        </form>
      ) : (
        <p className={styles.chatOff}>
          <Lock aria-hidden /> The host has turned off chat for everyone else.
        </p>
      )}
    </div>
  )
}

function HostPanel({ controller }: { controller: MeetingController }) {
  const settings = useMeeting((s) => s.settings)
  return (
    <div className={styles.section}>
      <p className={styles.hint}>Use these settings to keep control of your meeting. Only hosts can change them.</p>
      <h3 className={styles.sectionTitle}>Meeting moderation</h3>
      <Switch
        checked={settings.locked}
        onChange={(locked) => controller.updateSettings({ locked })}
        label="Host must let people in"
        description="Everyone without host access asks to join, and a host admits them."
      />
      <h3 className={styles.sectionTitle}>Let everyone</h3>
      <Switch
        checked={settings.screen_share_enabled}
        onChange={(v) => controller.updateSettings({ screen_share_enabled: v })}
        label={
          <>
            <MonitorUp className={styles.inlineIcon} aria-hidden /> Share their screen
          </>
        }
      />
      <Switch
        checked={settings.chat_enabled}
        onChange={(v) => controller.updateSettings({ chat_enabled: v })}
        label={
          <>
            <MessageSquareText className={styles.inlineIcon} aria-hidden /> Send chat messages
          </>
        }
      />
      <Switch
        checked={settings.reactions_enabled}
        onChange={(v) => controller.updateSettings({ reactions_enabled: v })}
        label={
          <>
            <SmilePlus className={styles.inlineIcon} aria-hidden /> Send reactions
          </>
        }
      />
      <div className={styles.danger}>
        <Button variant="danger" onClick={() => controller.endForEveryone()}>
          End the call for everyone
        </Button>
      </div>
    </div>
  )
}
