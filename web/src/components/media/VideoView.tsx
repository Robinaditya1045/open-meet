import { useEffect, useRef, useState } from 'react'
import { cx } from '../../lib/format'
import styles from './VideoView.module.css'

interface VideoViewProps {
  track: MediaStreamTrack | null
  mirrored?: boolean
  fit?: 'cover' | 'contain'
  className?: string
  /** Reports whether a frame has been painted since this track was attached. */
  onFrames?: (hasFrames: boolean) => void
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/**
 * Plays one video track and stays invisible until it has a picture.
 *
 * A forwarded track can be attached long before any frame arrives (the SFU
 * waits for a keyframe), and a receiver's track can be recycled for someone
 * else, so "has a track" is not "has a picture". The first painted frame is.
 */
export function VideoView({ track, mirrored, fit = 'cover', className, onFrames }: VideoViewProps) {
  const ref = useRef<FrameCallbackVideo>(null)
  const [hasFrames, setHasFrames] = useState(false)
  const onFramesRef = useRef(onFrames)
  useEffect(() => {
    onFramesRef.current = onFrames
  })

  useEffect(() => {
    const el = ref.current
    const report = (v: boolean) => {
      setHasFrames(v)
      onFramesRef.current?.(v)
    }
    report(false)
    if (!el || !track) return
    el.srcObject = new MediaStream([track])
    let cancelled = false
    let handle: number | undefined
    const painted = () => {
      if (!cancelled) report(true)
    }
    if (el.requestVideoFrameCallback) {
      handle = el.requestVideoFrameCallback(painted)
    } else {
      el.addEventListener('loadeddata', painted, { once: true })
    }
    el.play().catch(() => {
      // Muted video may autoplay everywhere; a rejection here is a transient
      // interruption, and the autoPlay attribute retries.
    })
    return () => {
      cancelled = true
      if (handle !== undefined) el.cancelVideoFrameCallback?.(handle)
      el.removeEventListener('loadeddata', painted)
      el.srcObject = null
    }
  }, [track])

  return (
    <video
      ref={ref}
      className={cx(styles.video, mirrored && styles.mirrored, fit === 'contain' && styles.contain, className)}
      data-has-frames={hasFrames || undefined}
      autoPlay
      playsInline
      muted
    />
  )
}
