// REST calls. The client always talks to its own origin (Vite proxies in
// development), unless VITE_MEET_API points it at a server elsewhere.

const API_BASE = (import.meta.env.VITE_MEET_API as string | undefined)?.replace(/\/$/, '') ?? ''

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.")
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(res.status, (body as { error?: string }).error ?? `Request failed (${res.status})`)
  }
  return body as T
}

export interface CreatedMeeting {
  code: string
  host_key: string
  created_at: number
}

export interface MeetingSummary {
  code: string
  participant_count: number
  names: string[]
  locked: boolean
}

export function createMeeting(): Promise<CreatedMeeting> {
  return request('/api/meetings', { method: 'POST', body: '{}' })
}

export function getMeeting(code: string): Promise<MeetingSummary> {
  return request(`/api/meetings/${encodeURIComponent(code)}`)
}

/** The signaling socket URL for a meeting. */
export function socketUrl(code: string): string {
  const base = API_BASE || window.location.origin
  const url = new URL(`${base}/api/meetings/${encodeURIComponent(code)}/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** The link people use to join a meeting. */
export function meetingLink(code: string): string {
  return `${window.location.origin}/${code}`
}
