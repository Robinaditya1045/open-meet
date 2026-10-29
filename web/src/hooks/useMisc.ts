import { useEffect, useState, useSyncExternalStore } from 'react'
import { listDevices, type DeviceList } from '../lib/rtc/devices'

/** The current time, updated each minute on the minute. */
export function useClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const delay = 60_000 - (Date.now() % 60_000) + 50
      timer = setTimeout(() => {
        setNow(new Date())
        schedule()
      }, delay)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [])
  return now
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/**
 * The devices the browser offers, refreshed when one is plugged in or out. The
 * list only has labels once some permission has been granted, so callers bump
 * `refreshKey` after acquiring a track.
 */
export function useDevices(refreshKey: unknown): DeviceList {
  const [devices, setDevices] = useState<DeviceList>({ audioinput: [], videoinput: [], audiooutput: [] })
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void listDevices().then((d) => {
        if (!cancelled) setDevices(d)
      })
    }
    refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
    }
  }, [refreshKey])
  return devices
}
