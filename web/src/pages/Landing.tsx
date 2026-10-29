import { CalendarPlus, Check, Copy, Keyboard, Link2, Plus, Video } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/common/Button'
import { Dialog } from '../components/common/Dialog'
import { Logo } from '../components/common/Logo'
import { Menu, MenuItem } from '../components/common/Menu'
import { useClock } from '../hooks/useMisc'
import { createMeeting, meetingLink } from '../lib/api'
import { clockTime, longDate, normalizeCode } from '../lib/format'
import { storage } from '../lib/storage'
import styles from './Landing.module.css'

export function Landing() {
  const navigate = useNavigate()
  const now = useClock()
  const [code, setCode] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [later, setLater] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const recent = storage.recentMeetings()

  const create = async (instant: boolean) => {
    setCreating(true)
    setError(null)
    try {
      const m = await createMeeting()
      storage.setHostKey(m.code, m.host_key)
      if (instant) navigate(`/${m.code}`)
      else setLater(m.code)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a meeting.')
    } finally {
      setCreating(false)
    }
  }

  const join = (e: FormEvent) => {
    e.preventDefault()
    const normalized = normalizeCode(code)
    if (!normalized) {
      setError("That doesn't look like a meeting code. Codes look like abc-defg-hjk.")
      return
    }
    navigate(`/${normalized}`)
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked; the link is selectable in the dialog.
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Logo />
        <div className={styles.clock}>
          {clockTime(now)} • {longDate(now)}
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.copy}>
          <h1 className={styles.title}>Meet face to face, from anywhere.</h1>
          <p className={styles.lede}>
            Start a call in one click and share the link. Anyone can join from a browser — no account, no install.
          </p>

          <div className={styles.actions}>
            <Menu
              side="bottom"
              align="start"
              trigger={
                <Button size="lg" icon={<Video />} loading={creating}>
                  New meeting
                </Button>
              }
            >
              <MenuItem icon={<Plus />} onSelect={() => void create(true)}>
                Start an instant meeting
              </MenuItem>
              <MenuItem icon={<CalendarPlus />} onSelect={() => void create(false)}>
                Create a meeting for later
              </MenuItem>
            </Menu>

            <form className={styles.join} onSubmit={join}>
              <label className={styles.codeField}>
                <Keyboard aria-hidden />
                <span className="sr-only">Meeting code or link</span>
                <input
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value)
                    setError(null)
                  }}
                  placeholder="Enter a code or link"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <Button type="submit" variant="ghost" size="lg" disabled={!code.trim()}>
                Join
              </Button>
            </form>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          {recent.length > 0 && (
            <div className={styles.recent}>
              <h2>Recent meetings</h2>
              <ul>
                {recent.map((r) => (
                  <li key={r.code}>
                    <button type="button" onClick={() => navigate(`/${r.code}`)}>
                      <Link2 aria-hidden />
                      <span className={styles.recentCode}>{r.code}</span>
                      <span className={styles.recentWhen}>{new Date(r.at).toLocaleDateString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className={styles.art} aria-hidden>
          <div className={styles.window}>
            <div className={styles.grid}>
              {['#3b6fd8', '#c2477a', '#2e8f6f', '#a6762a'].map((c, i) => (
                <div key={c} className={styles.tile} style={{ animationDelay: `${i * 90}ms` }}>
                  <span className={styles.face} style={{ background: c }}>
                    {['AL', 'GH', 'KJ', 'MS'][i]}
                  </span>
                  {i === 1 && <span className={styles.ring} />}
                  <span className={styles.nameTag}>{['Ada', 'Grace', 'Katherine', 'Margaret'][i]}</span>
                </div>
              ))}
            </div>
            <div className={styles.bar}>
              <span />
              <span />
              <span className={styles.barEnd} />
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        Media is relayed by this server&apos;s own SFU and is never recorded.
      </footer>

      <Dialog
        open={later !== null}
        onOpenChange={(open) => !open && setLater(null)}
        title="Here's your joining info"
        description="Send this link to the people you want to meet with. Save it so you can use it later, too."
        footer={
          <>
            <Button variant="ghost" onClick={() => setLater(null)}>
              Close
            </Button>
            <Button onClick={() => later && navigate(`/${later}`)}>Join now</Button>
          </>
        }
      >
        {later && (
          <div className={styles.linkBox}>
            <span className={styles.linkText}>{meetingLink(later)}</span>
            <Button
              variant="ghost"
              size="sm"
              icon={copied ? <Check /> : <Copy />}
              onClick={() => void copy(meetingLink(later))}
              aria-label="Copy meeting link"
            />
          </div>
        )}
      </Dialog>
    </div>
  )
}
