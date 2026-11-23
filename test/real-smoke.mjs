// Smoke test of the printer-hosted app against the REAL printer, in headless Chrome.
//
//   npm install            (playwright-core is a dev dependency; it drives the Chrome already installed)
//   npm run real-smoke -- http://<printer-ip>/cc/
//
// Safe by design: it looks at every tab and takes screenshots. The only command it
// sends on purpose is the chamber light, toggled and put back (skip with NOLIGHT=1).
// It never presses Print, Stop, Home, move, heat or delete.
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright-core')
const url = process.argv[2] ?? 'http://192.168.1.50/cc/'
const out = 'test/shots/real'
mkdirSync(out, { recursive: true })

const results = []
const note = (status, name, detail = '') => (results.push({ status, name, detail }), console.log(status.padEnd(5), name, detail ? `- ${detail}` : ''))
const step = async (name, fn) => {
  try {
    note('PASS', name, (await fn()) ?? '')
  } catch (e) {
    note('FAIL', name, String(e.message ?? e).split('\n')[0])
  }
}

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const pageErrors = []
const badRequests = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console: ${m.text()}`))
page.on('requestfailed', (r) => badRequests.push(`${r.url()} ${r.failure()?.errorText}`))
page.on('dialog', (d) => d.dismiss()) // never confirm anything
const tab = (name) => page.locator('nav button', { hasText: name }).click()
const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true })
const text = (sel) => page.locator(sel).first().innerText()

const t0 = Date.now()
await step('page loads from the printer', async () => {
  await page.goto(url, { timeout: 60000 })
  await page.locator('nav button').first().waitFor({ timeout: 30000 })
  return `${Date.now() - t0} ms`
})

await step('connects with no setup (address taken from the page)', async () => {
  await page.getByText('Connected', { exact: true }).waitFor({ timeout: 40000 })
  return `header "${await text('header.top h1')}" after ${Date.now() - t0} ms`
})

await step('status shows on the dashboard', async () => {
  await page.locator('.chip').first().waitFor({ timeout: 15000 })
  const chips = await page.locator('.chip').allInnerTexts()
  await page.waitForTimeout(2500)
  await shot('1-status')
  return `chips: ${chips.join(' | ')}`
})

await step('camera picture arrives', async () => {
  await page.locator('.cam img').waitFor({ timeout: 20000 })
  await page.waitForFunction(() => document.querySelector('.cam img')?.naturalWidth > 0, null, { timeout: 20000 })
  const size = await page.evaluate(() => {
    const i = document.querySelector('.cam img')
    return `${i.naturalWidth}x${i.naturalHeight}`
  })
  await shot('2-camera')
  return size
})

if (process.env.NOLIGHT !== '1')
  await step('light toggles and is put back', async () => {
    const btn = page.locator('button', { hasText: /^Light$/ }).first()
    const isOn = async () => (await btn.getAttribute('class')).split(' ').includes('on')
    const waitFor = async (want) => {
      for (let i = 0; i < 40; i++) {
        if ((await isOn()) === want) return true
        await page.waitForTimeout(500)
      }
      return false
    }
    const before = await isOn()
    await btn.click()
    const changed = await waitFor(!before)
    // Always try to put it back, even if the display never showed the change.
    await page.waitForTimeout(1500)
    if (changed) await btn.click()
    const restored = await waitFor(before)
    if (!changed) throw new Error(`clicked, but the button still shows ${before ? 'on' : 'off'} after 20 s (check the light by eye)`)
    if (!restored) throw new Error(`changed to ${before ? 'off' : 'on'} but did not show ${before ? 'on' : 'off'} again within 20 s: LIGHT MAY BE LEFT ${before ? 'OFF' : 'ON'}`)
    return `${before ? 'on' : 'off'} -> ${before ? 'off' : 'on'} -> ${before ? 'on' : 'off'}`
  })

await step('Control tab renders', async () => {
  await tab('Control')
  await page.waitForTimeout(1500)
  await shot('3-control')
  return (await text('main')).replace(/\s+/g, ' ').slice(0, 200)
})

await step('Files tab lists files and history', async () => {
  await tab('Files')
  await page.locator('.item').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(6000)
  const items = await page.locator('.item').count()
  const thumbs = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('main img')]
    return `${imgs.filter((i) => i.naturalWidth > 0).length}/${imgs.length} images loaded`
  })
  await shot('4-files')
  return `${items} rows, ${thumbs}; first: ${(await text('.item')).replace(/\s+/g, ' ').slice(0, 90)}`
})

await step('Care tab renders', async () => {
  await tab('Care')
  await page.waitForTimeout(800)
  await shot('5-care')
  return (await text('main')).replace(/\s+/g, ' ').slice(0, 160)
})

await step('Settings tab renders', async () => {
  await tab('Settings')
  await page.waitForTimeout(800)
  await shot('6-settings')
  return (await text('main')).replace(/\s+/g, ' ').slice(0, 160)
})

let consoleText = ''
await step('Console tab shows the conversation with the printer', async () => {
  await tab('Console')
  await page.waitForTimeout(800)
  consoleText = await text('main')
  await shot('7-console')
  return `${consoleText.split('\n').length} lines`
})

await step('still connected at the end', async () => {
  await page.getByText('Connected', { exact: true }).waitFor({ timeout: 5000 })
  return `${Math.round((Date.now() - t0) / 1000)} s after start`
})

await browser.close()
console.log('\n--- app console log ---\n' + consoleText)
console.log('\n--- page errors ---\n' + (pageErrors.join('\n') || 'none'))
console.log('\n--- failed requests ---\n' + (badRequests.join('\n') || 'none'))
const fails = results.filter((r) => r.status === 'FAIL').length
console.log(`\n${results.length - fails} passed, ${fails} failed. Screenshots in ${out}/`)
process.exit(fails ? 1 : 0)
