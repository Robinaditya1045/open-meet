import { CloseCode, type ClientMessages, type ServerMessages } from './protocol'

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface SignalingCallbacks {
  /** The socket is open; the first thing to send is a join. */
  onOpen: () => void
  onMessage: <K extends keyof ServerMessages>(type: K, data: ServerMessages[K]) => void
  onStatus: (status: SocketStatus) => void
  /** The connection is gone for good: closed with a final code, or retries ran out. */
  onClosed: (code: number, reason: string) => void
}

/** Close codes that mean "do not come back". */
const FINAL_CODES = new Set<number>([
  CloseCode.Left,
  CloseCode.Removed,
  CloseCode.Denied,
  CloseCode.Ended,
  CloseCode.NotFound,
  CloseCode.Full,
  CloseCode.Protocol,
  CloseCode.Replaced,
])

const PING_INTERVAL_MS = 8_000
/**
 * A browser can take minutes to notice a TCP connection that died on a network
 * change. Hearing nothing for this long means it is dead, whatever the socket says.
 */
const SILENCE_LIMIT_MS = 20_000
/** How long to keep trying before giving up on the meeting. */
const RETRY_WINDOW_MS = 60_000

/**
 * The meeting's signaling connection: one WebSocket, reopened with backoff
 * whenever it drops for a reason that is not final. Callers resume their
 * session from onOpen each time.
 */
export class Signaling {
  private ws: WebSocket | null = null
  private status: SocketStatus = 'connecting'
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private lastHeard = 0
  private droppedAt = 0
  private finished = false
  private readonly url: string
  private readonly callbacks: SignalingCallbacks

  constructor(url: string, callbacks: SignalingCallbacks) {
    this.url = url
    this.callbacks = callbacks
    window.addEventListener('online', this.handleOnline)
  }

  connect(): void {
    if (this.finished) return
    clearTimeout(this.retryTimer)
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.attempt = 0
      this.droppedAt = 0
      this.lastHeard = Date.now()
      this.setStatus('open')
      this.startPinging()
      this.callbacks.onOpen()
    }
    ws.onmessage = (event) => {
      if (this.ws !== ws) return
      this.lastHeard = Date.now()
      let parsed: { type: keyof ServerMessages; data: never }
      try {
        parsed = JSON.parse(event.data as string)
      } catch {
        return
      }
      this.callbacks.onMessage(parsed.type, parsed.data)
    }
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopPinging()
      this.handleClose(event.code, event.reason)
    }
  }

  send<K extends keyof ClientMessages>(type: K, data?: ClientMessages[K]): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(data === undefined ? { type } : { type, data }))
    return true
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** Ends the connection for good. */
  close(): void {
    this.finished = true
    clearTimeout(this.retryTimer)
    this.stopPinging()
    window.removeEventListener('online', this.handleOnline)
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000)
    this.setStatus('closed')
  }

  private handleClose(code: number, reason: string): void {
    if (this.finished) return
    if (FINAL_CODES.has(code)) {
      this.finish(code, reason)
      return
    }
    if (!this.droppedAt) this.droppedAt = Date.now()
    if (Date.now() - this.droppedAt > RETRY_WINDOW_MS) {
      this.finish(code, reason || 'Lost connection')
      return
    }
    this.setStatus('reconnecting')
    const delay = Math.min(500 * 2 ** this.attempt, 5_000) * (0.75 + Math.random() * 0.5)
    this.attempt++
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  private finish(code: number, reason: string): void {
    this.finished = true
    window.removeEventListener('online', this.handleOnline)
    this.setStatus('closed')
    this.callbacks.onClosed(code, reason)
  }

  private handleOnline = () => {
    // Back online: no point waiting out the backoff.
    if (this.status === 'reconnecting' && !this.ws) this.connect()
  }

  private startPinging(): void {
    this.stopPinging()
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) {
        // A dead connection can take as long to report its close as it took to
        // notice it was dead, so it is abandoned rather than closed and waited on.
        const ws = this.ws
        this.ws = null
        this.stopPinging()
        if (ws) {
          ws.onopen = ws.onmessage = ws.onclose = null
          ws.close()
        }
        this.handleClose(1006, 'connection went silent')
        return
      }
      this.send('ping')
    }, PING_INTERVAL_MS)
  }

  private stopPinging(): void {
    clearInterval(this.pingTimer)
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return
    this.status = status
    this.callbacks.onStatus(status)
  }
}
