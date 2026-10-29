// A server restart mid-call: everyone reconnects, rejoins the same meeting
// (its link is persisted) and gets media again. Spawns its own server on
// separate ports; MEET_BIN points at a built binary (make build → bin/meet).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, joinFromGreenRoom, launch, participant, sleep, state, summary, videoStats, waitForPhase, waitUntil } from './lib.mjs'

const bin = path.resolve(process.env.MEET_BIN ?? '../bin/meet')
const webDir = path.resolve(new URL('../web/dist', import.meta.url).pathname)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-restart-'))
const PORT = 8099
const BASE = `http://localhost:${PORT}`

function startServer() {
  const proc = spawn(bin, [], {
    env: {
      ...process.env,
      MEET_HTTP_ADDR: `:${PORT}`,
      MEET_RTC_UDP_PORT: '7892',
      MEET_RTC_TCP_PORT: '7891',
      MEET_DATA_DIR: dataDir,
      MEET_WEB_DIR: webDir,
      MEET_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  return proc
}

async function healthy() {
  return waitUntil(() => fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false), 10000, 200)
}

let server = startServer()
const browser = await launch()
try {
  await healthy()
  const created = await (await fetch(`${BASE}/api/meetings`, { method: 'POST' })).json()
  const url = `${BASE}/${created.code}`
  const ada = await participant(browser, 'Ada')
  await joinFromGreenRoom(ada, `${url}?host=${created.host_key}`)
  await waitForPhase(ada, 'joined')
  const grace = await participant(browser, 'Grace')
  await joinFromGreenRoom(grace, url)
  await waitForPhase(grace, 'joined')
  const graceIdBefore = await state(grace, (s) => s.selfId)
  const flowing = (p) =>
    waitUntil(async () => (await videoStats(p)).inbound.some((i) => i.framesDecoded > 5 && i.track.startsWith('camera.')), 20000)
  check('call is up before the restart', !!(await flowing(ada)) && !!(await flowing(grace)))

  // SIGTERM is a graceful restart: clients are told "service restart" (1012).
  server.kill('SIGTERM')
  await new Promise((r) => server.once('exit', r))
  const reconnecting = await waitUntil(() => state(grace, (s) => s.socket === 'reconnecting'), 5000)
  check('clients notice the server going away', !!reconnecting)
  await sleep(1500)
  server = startServer()
  await healthy()

  const back = await waitUntil(async () => {
    const a = await state(ada, (s) => s.phase === 'joined' && s.socket === 'open' && s.participants.length === 2)
    const g = await state(grace, (s) => s.phase === 'joined' && s.socket === 'open' && s.participants.length === 2)
    return a && g
  }, 25000)
  check('both rejoin the persisted meeting', !!back)
  const graceIdAfter = await state(grace, (s) => s.selfId)
  check('the restart starts a fresh session', graceIdAfter && graceIdAfter !== graceIdBefore)
  const adaStillHost = await state(ada, (s) => s.participants.find((p) => p.id === s.selfId)?.is_host)
  check('host keeps host rights after the restart', adaStillHost === true)
  const media = await waitUntil(async () => {
    const id = graceIdAfter
    const v = await videoStats(ada)
    return v.inbound.some((i) => i.track === `camera.${id}` && i.framesDecoded > 5)
  }, 25000)
  check('media flows again after the restart', !!media, JSON.stringify((await videoStats(ada)).inbound))
  // The big two-person tile asks for a high layer, and the new connection must
  // hear about it even though the tile never changed size.
  const upgraded = await waitUntil(async () => {
    const v = await videoStats(ada)
    return v.inbound.find((i) => i.track === `camera.${graceIdAfter}` && (i.height ?? 0) > 180)
  }, 15000)
  check('the viewer gets a layer that fits its tile again', !!upgraded, JSON.stringify(upgraded ?? (await videoStats(ada)).inbound))
} catch (err) {
  check('scenario ran to completion', false, err.stack)
} finally {
  await browser.close()
  server.kill('SIGTERM')
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exitCode = summary() ? 1 : 0
}
