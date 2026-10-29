let sharedContext: AudioContext | null = null

function context(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContext()
  return sharedContext
}

/**
 * Watches a microphone's loudness locally, for the level meter in the green room
 * and the "are you talking?" hint while muted. In the call, everyone's levels
 * come from the server instead.
 *
 * It listens to a clone: muting the published track (enabled = false) must not
 * blind the meter that notices someone talking while muted.
 */
export function watchLevel(track: MediaStreamTrack, onLevel: (level: number) => void): () => void {
  const clone = track.clone()
  clone.enabled = true
  const ctx = context()
  void ctx.resume().catch(() => {})
  const source = ctx.createMediaStreamSource(new MediaStream([clone]))
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.6
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)

  let raf = 0
  let last = 0
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    if (now - last < 60) return
    last = now
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const s of samples) sum += s * s
    const db = 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8)
    // Same scale as the server's: -55 dBFS is room tone, -15 dBFS is close speech.
    onLevel(Math.max(0, Math.min(1, (db + 55) / 40)))
  }
  raf = requestAnimationFrame(tick)

  return () => {
    cancelAnimationFrame(raf)
    source.disconnect()
    analyser.disconnect()
    clone.stop()
  }
}

/** Resumes the shared audio context from a user gesture, as autoplay policy requires. */
export function unlockAudio(): void {
  void context().resume().catch(() => {})
}
