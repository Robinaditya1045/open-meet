// Phone layouts, the settled landing page, and the waiting room preview.
import {
  BASE, check, clickButton, clickLabel, joinFromGreenRoom, launch, participant, shot, sleep, state, summary,
  waitForPhase, waitUntil,
} from './lib.mjs'

const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const browser = await launch()
const noOverflow = async (p, where) => {
  const w = await p.page.evaluate(() => ({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth }))
  check(`no horizontal overflow: ${where}`, w.inner === 390 && w.scroll <= 390, JSON.stringify(w))
}
try {
  const desk = await participant(browser, 'Desk', { width: 1440, height: 900 })
  await desk.page.goto(BASE, { waitUntil: 'networkidle0' })
  await sleep(900)
  await shot(desk, '20-landing-settled.png')

  const phoneHome = await participant(browser, 'Phone', PHONE)
  await phoneHome.page.goto(BASE, { waitUntil: 'networkidle0' })
  await sleep(900)
  await shot(phoneHome, '21-landing-phone.png')
  await noOverflow(phoneHome, 'landing')

  const created = await (await fetch(`${BASE}/api/meetings`, { method: 'POST' })).json()
  const url = `${BASE}/${created.code}`
  const ada = await participant(browser, 'Ada', { width: 1280, height: 800 })
  await joinFromGreenRoom(ada, `${url}?host=${created.host_key}`)
  await waitForPhase(ada, 'joined')

  const grace = await participant(browser, 'Grace Hopper', PHONE)
  await grace.page.goto(url, { waitUntil: 'domcontentloaded' })
  await grace.page.waitForSelector('video[data-has-frames]', { timeout: 15000 })
  await sleep(400)
  await shot(grace, '22-green-room-phone.png')
  await noOverflow(grace, 'green room')
  await joinFromGreenRoom(grace, null)
  await waitForPhase(grace, 'joined')
  await waitUntil(() => grace.page.evaluate(() => document.querySelectorAll('video[data-has-frames]').length >= 2), 15000)
  await sleep(500)
  await shot(grace, '23-duo-phone.png')
  await noOverflow(grace, 'two-person call')

  const extra = []
  for (const name of ['Katherine', 'Margaret', 'Hedy']) {
    const p = await participant(browser, name, { width: 800, height: 600 })
    await joinFromGreenRoom(p, url)
    await waitForPhase(p, 'joined')
    extra.push(p)
  }
  await waitUntil(() => grace.page.evaluate(() => document.querySelectorAll('video[data-has-frames]').length >= 5), 20000)
  await sleep(600)
  await shot(grace, '24-grid-phone.png')
  await noOverflow(grace, 'five-person grid')

  await clickLabel(grace.page, 'More options')
  await sleep(400)
  await shot(grace, '25-more-menu-phone.png')
  await clickButton(grace.page, 'In-call messages')
  await sleep(400)
  await grace.page.type('textarea', 'Typing from a phone')
  await grace.page.keyboard.press('Enter')
  await sleep(500)
  await shot(grace, '26-chat-phone.png')
  await noOverflow(grace, 'chat panel')
  await clickLabel(grace.page, 'Close')

  // Waiting room shows your own camera while you wait.
  await ada.page.evaluate(() => window.__meet.controller.updateSettings({ locked: true }))
  await waitUntil(() => state(ada, (s) => s.settings.locked), 5000)
  const knock = await participant(browser, 'Knocker', { width: 1280, height: 800 })
  await joinFromGreenRoom(knock, url)
  await waitForPhase(knock, 'waiting')
  const preview = await waitUntil(() => knock.page.evaluate(() => !!document.querySelector('video[data-has-frames]')), 8000)
  check('waiting room shows your camera', !!preview)
  await shot(knock, '27-waiting-settled.png')

  // A host on a phone gets the knock as a toast too.
  const hostPhone = await participant(browser, 'Host phone', PHONE)
  await joinFromGreenRoom(hostPhone, `${url}?host=${created.host_key}`)
  await waitForPhase(hostPhone, 'joined')
  await hostPhone.page.waitForFunction(() => document.body.textContent.includes('wants to join'), { timeout: 8000 })
  await sleep(500)
  await shot(hostPhone, '28-knock-phone.png')
  await noOverflow(hostPhone, 'knock toast')
} catch (err) {
  check('scenario ran to completion', false, err.stack)
} finally {
  await browser.close()
  process.exitCode = summary() ? 1 : 0
}
