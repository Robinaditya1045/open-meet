// Shared helpers for the browser tests. Each participant is an isolated
// browser context with Chrome's fake camera and microphone.
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

export const BASE = process.env.BASE ?? 'http://localhost:8088'
export const OUT = new URL('./shots/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })

export const results = []
export function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

export async function launch() {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--auto-select-desktop-capture-source=Entire screen',
      '--auto-accept-this-tab-capture',
      '--window-size=1280,800',
    ],
  })
}

export async function participant(browser, name, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport(viewport)
  page.on('console', (m) => {
    const t = m.type()
    if (t === 'error' || t === 'warn') console.log(`  [${name} console.${t}] ${m.text()}`)
  })
  page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message}`))
  return { ctx, page, name }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function clickButton(page, text) {
  const handle = await page.waitForFunction(
    (t) => [...document.querySelectorAll('button, [role="menuitem"]')].find((b) => b.textContent.trim().includes(t) && !b.disabled),
    { timeout: 15000 },
    text,
  )
  await handle.asElement().click()
}

export async function clickLabel(page, label) {
  const handle = await page.waitForFunction(
    (l) => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === l && !b.disabled),
    { timeout: 15000 },
    label,
  )
  await handle.asElement().click()
}

/** From the green room: set the name and join. */
export async function joinFromGreenRoom(p, url, { present = false } = {}) {
  if (url) await p.page.goto(url, { waitUntil: 'domcontentloaded' })
  const input = await p.page.waitForSelector('input[autocomplete="name"]')
  await input.click({ clickCount: 3 })
  await input.type(p.name)
  await clickButton(p.page, present ? 'Present' : 'Join now').catch(() => clickButton(p.page, 'Ask to join'))
}

export async function phase(p) {
  return p.page.evaluate(() => window.__meet?.useMeeting.getState().phase)
}

export async function waitForPhase(p, want, timeout = 15000) {
  await p.page.waitForFunction((w) => window.__meet?.useMeeting.getState().phase === w, { timeout }, want)
}

export async function state(p, fn) {
  return p.page.evaluate(`(${fn})(window.__meet.useMeeting.getState(), window.__meet)`)
}

export async function videoStats(p) {
  return p.page.evaluate(() => window.__meet.controller.videoStats())
}

/** Inbound audio packets per forwarded mic, via the raw peer connection stats. */
export async function audioStats(p) {
  return p.page.evaluate(async () => {
    const c = window.__meet.controller
    const pc = c.rtc?.pc
    if (!pc) return []
    const remote = window.__meet.useMeeting.getState().remote
    const byMid = new Map()
    for (const t of pc.getTransceivers()) {
      const name = Object.entries(remote).find(([, tr]) => tr === t.receiver.track)?.[0]
      if (t.mid && name) byMid.set(t.mid, name)
    }
    const out = []
    ;(await pc.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') out.push({ track: byMid.get(s.mid) ?? s.mid, packets: s.packetsReceived })
    })
    return out
  })
}

export async function waitUntil(fn, timeout = 15000, every = 300) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(every)
  }
  return last
}

export async function shot(p, file) {
  await p.page.screenshot({ path: OUT + file })
}

export function summary() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  for (const f of failed) console.log(`  FAILED: ${f.name} ${f.detail}`)
  return failed.length
}
