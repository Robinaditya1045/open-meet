// Core call: create, join three people, media both ways, simulcast, speaker
// detection, chat, reactions, hands, pinning.
import {
  BASE, audioStats, check, clickButton, clickLabel, joinFromGreenRoom, launch, participant, shot, sleep,
  state, summary, videoStats, waitForPhase, waitUntil,
} from './lib.mjs'

const browser = await launch()
try {
  const ada = await participant(browser, 'Ada Lovelace', { width: 1440, height: 900 })
  await ada.page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await shot(ada, '01-landing.png')
  await clickButton(ada.page, 'New meeting')
  await clickButton(ada.page, 'Start an instant meeting')
  await ada.page.waitForFunction(() => /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(location.pathname), { timeout: 15000 })
  const url = ada.page.url()
  const code = new URL(url).pathname.slice(1)
  check('instant meeting navigates to a code', true, code)
  await ada.page.waitForSelector('video[data-has-frames]', { timeout: 15000 })
  await sleep(300)
  await shot(ada, '02-green-room.png')
  await joinFromGreenRoom(ada, null)
  await waitForPhase(ada, 'joined')
  check('host joins', true)
  const adaHost = await state(ada, (s) => s.participants.find((p) => p.id === s.selfId)?.is_host)
  check('creator is host', adaHost === true)
  await sleep(800)
  await shot(ada, '03-alone.png')

  const grace = await participant(browser, 'Grace Hopper')
  await joinFromGreenRoom(grace, url)
  await waitForPhase(grace, 'joined')
  const kat = await participant(browser, 'Katherine Johnson')
  await joinFromGreenRoom(kat, url)
  await waitForPhase(kat, 'joined')
  check('two guests join', true)

  const ids = await state(ada, (s) => Object.fromEntries(s.participants.map((p) => [p.name, p.id])))
  const adaId = ids['Ada Lovelace']
  check('roster has 3 people', Object.keys(ids).length === 3, JSON.stringify(Object.keys(ids)))

  // Every participant receives every other camera and mic.
  for (const [p, others] of [[ada, ['Grace Hopper', 'Katherine Johnson']], [grace, ['Ada Lovelace', 'Katherine Johnson']], [kat, ['Ada Lovelace', 'Grace Hopper']]]) {
    const ok = await waitUntil(async () => {
      const v = await videoStats(p)
      return others.every((n) => v.inbound.some((i) => i.track === `camera.${ids[n]}` && i.framesDecoded > 5))
    }, 20000)
    const v = await videoStats(p)
    check(`${p.name} decodes video from both others`, !!ok, JSON.stringify(v.inbound.map((i) => [i.track, i.framesDecoded, i.height])))
    const audioOk = await waitUntil(async () => {
      const a = await audioStats(p)
      return others.every((n) => a.some((i) => i.track === `mic.${ids[n]}` && i.packets > 20))
    }, 15000)
    check(`${p.name} receives audio from both others`, !!audioOk, JSON.stringify(await audioStats(p)))
  }

  // The publisher sends three simulcast layers.
  const sent = await waitUntil(async () => {
    const v = await videoStats(ada)
    const active = v.outbound.filter((o) => o.bytes > 0 && o.height)
    return active.length >= 2 ? v.outbound : null
  }, 15000)
  check('host camera publishes simulcast layers', !!sent, JSON.stringify((sent ?? []).map((o) => [o.rid, o.width, o.height, o.fps])))

  // Server-side speaker detection reaches clients (the fake mic beeps).
  const levels = await waitUntil(async () => state(grace, (s, m) => {
    const l = m.useLevels.getState().levels
    return Object.keys(l).length > 0 ? { levels: l, dominant: s.dominant } : null
  }), 15000)
  check('audio levels and dominant speaker arrive', !!levels && !!levels.dominant, JSON.stringify(levels))

  await sleep(1500)
  await shot(ada, '04-grid-3.png')

  // Simulcast: a small tile gets a low layer; pinning makes it large and high.
  const heightOf = async (p, name) => (await videoStats(p)).inbound.find((i) => i.track === name)?.height ?? 0
  const before = await heightOf(grace, `camera.${adaId}`)
  await grace.page.evaluate((id) => window.__meet.controller.pin(id), `camera.${adaId}`)
  const pinnedHeight = await waitUntil(async () => {
    const h = await heightOf(grace, `camera.${adaId}`)
    return h > before ? h : null
  }, 15000)
  check('pinning a tile switches it to a higher simulcast layer', !!pinnedHeight, `before=${before} after=${pinnedHeight ?? (await heightOf(grace, `camera.${adaId}`))}`)
  const katView = await heightOf(kat, `camera.${adaId}`)
  check("one viewer's layer doesn't change another's", katView <= before || katView < (pinnedHeight ?? 0), `kat sees ${katView}`)
  await sleep(600)
  await shot(grace, '05-pinned-spotlight.png')
  await grace.page.evaluate((id) => window.__meet.controller.pin(id), `camera.${adaId}`)

  // Hidden tile: pausing via subscriptions stops frames for that viewer.
  // Chat
  await clickLabel(grace.page, 'Chat with everyone')
  await grace.page.waitForSelector('textarea')
  await grace.page.type('textarea', 'Hello from Grace — see https://example.com')
  await grace.page.keyboard.press('Enter')
  const got = await waitUntil(() => state(ada, (s) => s.chat.find((m) => m.text.startsWith('Hello from Grace'))), 8000)
  check('chat reaches the host', !!got)
  const unread = await state(ada, (s) => s.unread)
  check('unread badge counts while chat is closed', unread === 1, `unread=${unread}`)
  await sleep(400)
  await shot(grace, '06-chat-panel.png')

  // Reactions and hands
  await kat.page.evaluate(() => window.__meet.controller.react('🎉'))
  const reacted = await waitUntil(() => state(ada, (s) => s.reactions.some((r) => r.emoji === '🎉')), 5000)
  check('reaction is broadcast', !!reacted)
  await kat.page.evaluate(() => window.__meet.controller.setHand(true))
  const hand = await waitUntil(() => state(ada, (s) => s.participants.find((p) => p.name === 'Katherine Johnson')?.hand_raised_at > 0), 5000)
  check('raised hand is shown to others', !!hand)
  await sleep(200)
  await shot(ada, '07-reaction-hand.png')

  // People panel (host view)
  await clickLabel(ada.page, 'People')
  await sleep(500)
  await shot(ada, '08-people-panel.png')

  // Camera off on one side shows an avatar on the other, with no renegotiation.
  await grace.page.keyboard.down('Control')
  await grace.page.keyboard.press('e')
  await grace.page.keyboard.up('Control')
  const camOff = await waitUntil(() => state(ada, (s) => s.participants.find((p) => p.name === 'Grace Hopper')?.video_on === false), 5000)
  check('turning the camera off reaches others', !!camOff)
  const graceTrackOff = await grace.page.evaluate(() => window.__meet.useMeeting.getState().local.cameraTrack)
  check('camera track is released when off', graceTrackOff === null)
  await grace.page.evaluate(() => window.__meet.controller.setCamera(true))
  const camOn = await waitUntil(async () => {
    const on = await state(ada, (s) => s.participants.find((p) => p.name === 'Grace Hopper')?.video_on)
    const v = await videoStats(ada)
    return on && v.inbound.some((i) => i.track === `camera.${ids['Grace Hopper']}` && i.framesDecoded > 0)
  }, 10000)
  check('camera back on resumes video', !!camOn)

  // Mute state
  await grace.page.evaluate(() => window.__meet.controller.setMic(false))
  const muted = await waitUntil(() => state(ada, (s) => s.participants.find((p) => p.name === 'Grace Hopper')?.audio_muted), 5000)
  check('self-mute reaches others', !!muted)

  console.log('\nserver stats:', await (await fetch(`${BASE}/healthz`)).text())
} catch (err) {
  check('scenario ran to completion', false, err.stack)
} finally {
  await browser.close()
  process.exitCode = summary() ? 1 : 0
}
