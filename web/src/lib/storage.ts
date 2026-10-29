// Small persistence helpers. Every access is wrapped: storage can be disabled
// (private windows, blocked site data) and the app must keep working without it.

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

function write(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key)
    else storage().setItem(key, value)
  } catch {
    // Storage unavailable; the value just won't be remembered.
  }
}

const local = () => window.localStorage
const session = () => window.sessionStorage

export const storage = {
  displayName: () => read(local, 'meet:name') ?? '',
  setDisplayName: (name: string) => write(local, 'meet:name', name),

  hostKey: (code: string) => read(local, `meet:host:${code}`),
  setHostKey: (code: string, key: string) => write(local, `meet:host:${code}`, key),

  /**
   * The token that resumes this tab's place in a meeting. Per tab, so a second
   * tab joins as a second person rather than taking over the first.
   */
  resumeToken: (code: string) => read(session, `meet:resume:${code}`),
  setResumeToken: (code: string, token: string | null) => write(session, `meet:resume:${code}`, token),

  device: (kind: 'audioinput' | 'videoinput' | 'audiooutput') => read(local, `meet:device:${kind}`),
  setDevice: (kind: 'audioinput' | 'videoinput' | 'audiooutput', id: string) =>
    write(local, `meet:device:${kind}`, id),

  bool: (key: string, fallback: boolean) => {
    const v = read(local, `meet:pref:${key}`)
    return v === null ? fallback : v === '1'
  },
  setBool: (key: string, value: boolean) => write(local, `meet:pref:${key}`, value ? '1' : '0'),

  recentMeetings: (): { code: string; at: number }[] => {
    try {
      const parsed = JSON.parse(read(local, 'meet:recent') ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((r) => typeof r?.code === 'string') : []
    } catch {
      return []
    }
  },
  rememberMeeting: (code: string) => {
    const rest = storage.recentMeetings().filter((r) => r.code !== code)
    write(local, 'meet:recent', JSON.stringify([{ code, at: Date.now() }, ...rest].slice(0, 5)))
  },
}
