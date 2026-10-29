/** Joins class names, skipping falsy ones. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = Array.from(parts[0])[0] ?? ''
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : ''
  return (first + last).toUpperCase()
}

/** Avatar backgrounds: saturated enough to tell people apart, dark enough for white initials. */
const AVATAR_COLORS = ['#3b6fd8', '#8a4fd6', '#c2477a', '#d1593a', '#2e8f6f', '#1f88a8', '#a6762a', '#5d6bd8', '#b04ab8', '#3f8f3a']

export function avatarColor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export function clockTime(date = new Date()): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function longDate(date = new Date()): string {
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export function messageTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "Ada", "Ada and Grace", "Ada, Grace and 3 others". */
export function namesSentence(names: string[], total: number): string {
  if (total <= 0 || names.length === 0) return ''
  if (total === 1) return names[0]
  if (total === 2 && names.length >= 2) return `${names[0]} and ${names[1]}`
  const others = total - 1
  return `${names[0]} and ${others} ${others === 1 ? 'other' : 'others'}`
}

/** Accepts "abc-defg-hjk", "ABCDEFGHJK" or a meeting link; returns the canonical code or null. */
export function normalizeCode(raw: string): string | null {
  let s = raw.trim()
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  s = s.split(/[?#]/)[0]
  const letters = s.toLowerCase().replace(/[\s-]/g, '')
  if (!/^[abcdefghjkmnpqrstuvwxyz]{10}$/.test(letters)) return null
  return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`
}
