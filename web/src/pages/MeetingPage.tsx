import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { MeetingRoom } from '../components/room/MeetingRoom'
import { normalizeCode } from '../lib/format'
import { getCamera, getMicrophone } from '../lib/rtc/devices'
import { storage } from '../lib/storage'
import { MeetingController } from '../meeting/controller'
import { useLevels, useMeeting } from '../state/meeting'
import { clearToasts } from '../state/toast'
import { GreenRoom, type GreenRoomResult } from './GreenRoom'
import { EndScreen, WaitingRoom } from './StatusScreens'

export function MeetingPage() {
  const params = useParams()
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  const code = useMemo(() => normalizeCode(params.code ?? ''), [params.code])
  const [controller, setController] = useState<MeetingController | null>(null)
  const [notFound, setNotFound] = useState(false)
  const phase = useMeeting((s) => s.phase)
  const phaseBy = useMeeting((s) => s.phaseBy)

  // A host link (?host=…) grants host rights on this device, then disappears
  // from the address bar so it isn't shared by accident.
  useEffect(() => {
    const key = search.get('host')
    if (code && key) {
      storage.setHostKey(code, key)
      search.delete('host')
      setSearch(search, { replace: true })
    }
  }, [code, search, setSearch])

  // A typed or pasted variant of the code gets the canonical URL.
  useEffect(() => {
    if (code && params.code !== code) navigate(`/${code}`, { replace: true })
  }, [code, params.code, navigate])

  useEffect(() => {
    return () => {
      controller?.dispose()
      clearToasts()
    }
  }, [controller])

  // Closing the tab is leaving: everyone else should see it now, not after the
  // reconnect grace period.
  useEffect(() => {
    if (!controller) return
    const onHide = () => controller.dispose()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [controller])

  const start = useCallback(
    (r: GreenRoomResult) => {
      if (!code) return
      const c = new MeetingController({
        code,
        name: r.name,
        hostKey: storage.hostKey(code),
        micTrack: r.micTrack,
        cameraTrack: r.cameraTrack,
        micOn: r.micOn,
        cameraOn: r.cameraOn,
      })
      c.start()
      setController(c)
      // A handle for debugging from the console and for browser tests.
      ;(window as unknown as { __meet?: unknown }).__meet = { controller: c, useMeeting, useLevels }
      if (r.present) {
        const unsubscribe = useMeeting.subscribe((s) => {
          if (s.phase === 'joined' && s.media === 'connected') {
            unsubscribe()
            void c.startScreenShare()
          } else if (s.phase !== 'connecting' && s.phase !== 'joined' && s.phase !== 'waiting') {
            unsubscribe()
          }
        })
      }
    },
    [code],
  )

  const rejoin = useCallback(async () => {
    const micOn = storage.bool('mic', true)
    const cameraOn = storage.bool('camera', true)
    const micTrack = await getMicrophone().catch(() => null)
    const cameraTrack = cameraOn ? await getCamera().catch(() => null) : null
    clearToasts()
    start({
      name: storage.displayName() || 'Guest',
      micTrack,
      cameraTrack,
      micOn: micOn && !!micTrack,
      cameraOn: cameraOn && !!cameraTrack,
      present: false,
    })
  }, [start])

  const onNotFound = useCallback(() => setNotFound(true), [])

  if (!code || notFound) return <EndScreen phase="not_found" by={null} onRejoin={() => {}} />

  if (!controller) {
    return <GreenRoom code={code} isHost={!!storage.hostKey(code)} onJoin={start} onNotFound={onNotFound} />
  }
  if (phase === 'connecting' || phase === 'waiting') {
    return (
      <WaitingRoom
        onCancel={() => {
          controller.leave()
          navigate('/')
        }}
      />
    )
  }
  if (phase === 'joined') return <MeetingRoom controller={controller} />
  return <EndScreen phase={phase} by={phaseBy} onRejoin={() => void rejoin()} />
}
