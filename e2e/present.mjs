// "Present" from the green room joins and starts sharing in one step.
import { BASE, check, joinFromGreenRoom, launch, participant, summary, videoStats, waitForPhase, waitUntil, state } from './lib.mjs'

const browser = await launch()
try {
  const created = await (await fetch(`${BASE}/api/meetings`, { method: 'POST' })).json()
  const url = `${BASE}/${created.code}`
  const viewer = await participant(browser, 'Viewer')
  await joinFromGreenRoom(viewer, url)
  await waitForPhase(viewer, 'joined')

  const presenter = await participant(browser, 'Presenter')
  await joinFromGreenRoom(presenter, url, { present: true })
  await waitForPhase(presenter, 'joined')
  const sharing = await waitUntil(async () => {
    if (await state(presenter, (s) => s.local.sharing)) return 'sharing'
    const offered = await presenter.page.evaluate(() => document.body.textContent.includes('ready for you to present'))
    return offered ? 'offered' : null
  }, 15000)
  check('"Present" joins and shares, or offers a button to', !!sharing, sharing ?? 'neither')
  if (sharing === 'offered') {
    const [button] = await presenter.page.$$('xpath/.//button[contains(., "Present now")]')
    await button.click()
    await waitUntil(() => state(presenter, (s) => s.local.sharing), 10000)
  }
  const id = await state(presenter, (s) => s.selfId)
  const seen = await waitUntil(async () => (await videoStats(viewer)).inbound.find((i) => i.track === `screen.${id}` && i.framesDecoded > 3), 15000)
  check('the presentation reaches the other participant', !!seen, JSON.stringify(seen))
} catch (err) {
  check('scenario ran to completion', false, err.stack)
} finally {
  await browser.close()
  process.exitCode = summary() ? 1 : 0
}
