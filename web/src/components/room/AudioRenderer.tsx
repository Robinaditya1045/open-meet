import { useEffect, useRef } from 'react'
import { useMeeting } from '../../state/meeting'

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

/**
 * Browsers block play() until the page has seen a user gesture. Tracks arrive
 * asynchronously, often long after the click that joined, so the autoplay
 * attribute alone fails silently. Playing explicitly and retrying on the next
 * gesture is what makes remote audio reliable.
 */
function attemptPlay(el: HTMLAudioElement): void {
  el.play().catch(() => {
    const retry = () => {
      el.play().catch(() => {})
    }
    document.addEventListener('pointerdown', retry, { once: true })
    document.addEventListener('keydown', retry, { once: true })
  })
}

function RemoteAudio({ track, speakerId }: { track: MediaStreamTrack; speakerId: string | null }) {
  const ref = useRef<SinkAudio>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = new MediaStream([track])
    attemptPlay(el)
    return () => {
      el.srcObject = null
    }
  }, [track])

  useEffect(() => {
    const el = ref.current
    if (el?.setSinkId && speakerId) el.setSinkId(speakerId).catch(() => {})
  }, [speakerId])

  return <audio ref={ref} autoPlay />
}

/**
 * Plays everyone else's microphone. Each track keeps its own element for as long
 * as it exists: rebuilding them all whenever someone joins would cut out
 * everyone already talking.
 */
export function AudioRenderer() {
  const remote = useMeeting((s) => s.remote)
  const speakerId = useMeeting((s) => s.speakerId)
  const mics = Object.entries(remote).filter(([name]) => name.startsWith('mic.'))
  return (
    <div hidden>
      {mics.map(([name, track]) => (
        <RemoteAudio key={`${name}:${track.id}`} track={track} speakerId={speakerId} />
      ))}
    </div>
  )
}
