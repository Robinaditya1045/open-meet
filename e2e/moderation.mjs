// Presenting, host controls, the lobby, transceiver recycling in Chrome,
// surviving a signaling drop, removal and ending the call.
import {
  BASE, audioStats, check, clickButton, clickLabel, joinFromGreenRoom, launch, participant, shot, sleep,
  state, summary, videoStats, waitForPhase, waitUntil,
} from './lib.mjs'

const browser = await launch()
const idOf = (p) => state(p, (s) => s.selfId)
try {
  const created = await (await fetch(`${BASE}/api/meetings`, { method: 'POST' })).json()
  const url = `${BASE}/${created.code}`

  const ada = await participant(browser, 'Ada', { width: 1280, height: 800 })
  await joinFromGreenRoom(ada, `${url}?host=${created.host_key}`)
  await waitForPhase(ada, 'joined')
  check('host link grants host rights', await state(ada, (s) => s.participants.find((p) => p.id === s.selfId)?.is_host))
  check('host key is stripped from the address bar', !ada.page.url().includes('host='))

  const grace = await participant(browser, 'Grace')
  await joinFromGreenRoom(grace, url)
  await waitForPhase(grace, 'joined')
  const adaId = await idOf(ada)
  const graceId = await idOf(grace)
  await waitUntil(async () => (await videoStats(ada)).inbound.some((i) => i.track === `camera.${graceId}` && i.framesDecoded > 3), 15000)
  await sleep(500)
  await shot(ada, '10-duo.png')

  // Presenting: a click is needed for getDisplayMedia's user-activation rule.
  await clickLabel(ada.page, 'Present now')
  const presenting = await waitUntil(() => state(ada, (s) => s.local.sharing), 10000)
  check('host starts presenting', !!presenting)
  const screenSeen = await waitUntil(async () => {
    const v = await videoStats(grace)
    return v.inbound.find((i) => i.track === `screen.${adaId}` && i.framesDecoded > 3)
  }, 20000)
  check('guest receives the presentation', !!screenSeen, JSON.stringify(screenSeen))
  await sleep(800)
  await shot(grace, '11-presentation-guest.png')
  await shot(ada, '12-presentation-host.png')

  await clickButton(ada.page, 'Stop presenting')
  const stopped = await waitUntil(() => state(grace, (s) => !s.participants.find((p) => p.name === 'Ada')?.screen_sharing), 8000)
  check('stopping the presentation reaches the guest', !!stopped)
  // Presenting again reuses the screen transceiver without renegotiating.
  const txBefore = await ada.page.evaluate(() => window.__meet.controller.rtc.pc.getTransceivers().length)
  await clickLabel(ada.page, 'Present now')
  const again = await waitUntil(async () => {
    const v = await videoStats(grace)
    const on = await state(grace, (s) => s.participants.find((p) => p.name === 'Ada')?.screen_sharing)
    return on && v.inbound.some((i) => i.track === `screen.${adaId}` && i.framesDecoded > 10)
  }, 15000)
  const txAfter = await ada.page.evaluate(() => window.__meet.controller.rtc.pc.getTransceivers().length)
  check('presenting a second time works and adds no transceiver', !!again && txAfter === txBefore, `${txBefore} -> ${txAfter}`)
  await clickButton(ada.page, 'Stop presenting')

  // Host mutes a guest.
  await grace.page.evaluate(() => window.__meet.controller.setMic(true))
  await ada.page.evaluate((id) => window.__meet.controller.mute(id), graceId)
  const forced = await waitUntil(() => state(grace, (s) => !s.local.micOn), 5000)
  check('host can mute a guest', !!forced)

  // Lock the meeting; a knock is admitted from the toast, another denied.
  await ada.page.evaluate(() => window.__meet.controller.updateSettings({ locked: true }))
  await waitUntil(() => state(ada, (s) => s.settings.locked), 5000)
  const kat = await participant(browser, 'Katherine')
  await kat.page.goto(url, { waitUntil: 'domcontentloaded' })
  await kat.page.waitForFunction(() => document.body.textContent.includes('Ask to join'), { timeout: 15000 })
  check('green room offers "Ask to join" when locked', true)
  await joinFromGreenRoom(kat, null)
  await waitForPhase(kat, 'waiting')
  check('locked meeting puts a guest in the lobby', true)
  await shot(kat, '13-waiting.png')
  await ada.page.waitForFunction(() => document.body.textContent.includes('wants to join this call'), { timeout: 8000 })
  await shot(ada, '14-knock-toast.png')
  await clickButton(ada.page, 'Admit')
  await waitForPhase(kat, 'joined')
  check('host admits from the toast', true)
  const katId = await idOf(kat)

  const mag = await participant(browser, 'Margaret')
  await joinFromGreenRoom(mag, url)
  await waitForPhase(mag, 'waiting')
  await ada.page.waitForFunction(() => window.__meet.useMeeting.getState().lobby.length === 1, { timeout: 8000 })
  const magId = await ada.page.evaluate(() => window.__meet.useMeeting.getState().lobby[0].id)
  await ada.page.evaluate((id) => window.__meet.controller.deny(id), magId)
  await waitForPhase(mag, 'denied')
  check('host denies a knock', true)
  await sleep(300)
  await shot(mag, '15-denied.png')
  await ada.page.evaluate(() => window.__meet.controller.updateSettings({ locked: false }))

  // Recycling: Katherine leaves, Hedy joins; Grace's browser should get Hedy on
  // the m-lines Katherine left, and play her.
  await waitUntil(async () => (await videoStats(grace)).inbound.some((i) => i.track === `camera.${katId}` && i.framesDecoded > 3), 15000)
  const graceTx = await grace.page.evaluate(() => window.__meet.controller.rtc.pc.getTransceivers().length)
  await clickLabel(kat.page, 'Leave call')
  await waitForPhase(kat, 'left')
  await kat.page.waitForFunction(() => document.body.textContent.includes('You left the meeting'))
  await shot(kat, '16-left.png')
  const gone = await waitUntil(
    () => grace.page.evaluate((id) => !Object.keys(window.__meet.useMeeting.getState().remote).some((k) => k.endsWith(id)), katId),
    8000,
  )
  check("a leaver's tracks are removed from others", !!gone)
  await sleep(1500)

  const hedy = await participant(browser, 'Hedy')
  await joinFromGreenRoom(hedy, url)
  await waitForPhase(hedy, 'joined')
  const hedyId = await idOf(hedy)
  const hedyVideo = await waitUntil(async () => (await videoStats(grace)).inbound.find((i) => i.track === `camera.${hedyId}` && i.framesDecoded > 5), 20000)
  const hedyAudio = await waitUntil(async () => (await audioStats(grace)).find((a) => a.track === `mic.${hedyId}` && a.packets > 20), 15000)
  const graceTxAfter = await grace.page.evaluate(() => window.__meet.controller.rtc.pc.getTransceivers().length)
  check('Chrome plays media on recycled transceivers', !!hedyVideo && !!hedyAudio, JSON.stringify({ hedyVideo, hedyAudio }))
  check('recycling keeps the transceiver count flat', graceTxAfter === graceTx, `${graceTx} -> ${graceTxAfter}`)

  // A signaling drop resumes the same participant and keeps media flowing.
  const decodedBefore = (await videoStats(grace)).inbound.find((i) => i.track === `camera.${adaId}`)?.framesDecoded ?? 0
  const pcBefore = await grace.page.evaluate(() => {
    window.__pcBefore = window.__meet.controller.rtc.pc
    return true
  })
  await grace.page.evaluate(() => window.__meet.controller.signaling.ws.close())
  const resumed = await waitUntil(async () => {
    const s = await state(grace, (st) => ({ id: st.selfId, socket: st.socket, phase: st.phase }))
    return s.socket === 'open' && s.phase === 'joined' && s.id === graceId
  }, 15000)
  const samePc = await grace.page.evaluate(() => window.__pcBefore === window.__meet.controller.rtc.pc)
  const decodedAfter = await waitUntil(async () => {
    const d = (await videoStats(grace)).inbound.find((i) => i.track === `camera.${adaId}`)?.framesDecoded ?? 0
    return d > decodedBefore + 10 ? d : null
  }, 10000)
  const rosterSize = await state(ada, (s) => s.participants.length)
  check('signaling drop resumes the same participant', !!resumed && pcBefore, `roster=${rosterSize}`)
  check('media connection survives the signaling drop', samePc && !!decodedAfter, `samePc=${samePc}`)

  // Removal and ending.
  await ada.page.evaluate((id) => window.__meet.controller.remove(id), hedyId)
  await waitForPhase(hedy, 'removed')
  check('host removes a participant', true)
  await sleep(200)
  await shot(hedy, '17-removed.png')
  await ada.page.evaluate(() => window.__meet.controller.endForEveryone())
  await waitForPhase(grace, 'ended')
  check('host ends the call for everyone', true)
  await sleep(300)
  await shot(grace, '18-ended.png')
  const stats = await (await fetch(`${BASE}/healthz`)).json()
  check('server forgets the ended meeting', stats.stats.live_meetings === 0, JSON.stringify(stats))
} catch (err) {
  check('scenario ran to completion', false, err.stack)
} finally {
  await browser.close()
  process.exitCode = summary() ? 1 : 0
}
