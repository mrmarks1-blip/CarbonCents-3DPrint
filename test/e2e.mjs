// End-to-end check: drives the built app in a real browser against the fake
// printer.  Run with: npm run e2e
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Resolved with require so a globally installed Playwright (NODE_PATH) works too.
const { chromium } = createRequire(import.meta.url)('playwright')

const out = process.env.SHOTS ?? 'test/shots'
mkdirSync(out, { recursive: true })
const procs = [
  spawn('node', ['test/fake-printer.mjs'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env } }),
  spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { stdio: 'ignore' }),
]
let printerLog = ''
procs[0].stdout.on('data', (d) => (printerLog += d))
const steps = []
const ok = (name) => (steps.push(name), console.log('PASS', name))
let failed = false

const browser = await chromium.launch()
try {
  await new Promise((r) => setTimeout(r, 2500))
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  page.on('dialog', (d) => d.accept())
  const tab = (name) => page.locator('nav button', { hasText: name }).click()
  const shot = (name) => page.screenshot({ path: `${out}/${name}.png` })

  await page.goto('http://127.0.0.1:4173/')
  await page.getByPlaceholder('192.168.1.50').fill('127.0.0.1')
  await page.getByRole('button', { name: 'Save and connect' }).click()
  await page.getByText('Connected', { exact: true }).waitFor()
  await page.locator('.chip', { hasText: 'Idle' }).waitFor()
  ok('connects, detects the Elegoo protocol and shows idle status')

  await page.locator('.cam img').waitFor()
  await page.waitForFunction(() => document.querySelector('.cam img')?.naturalWidth > 0)
  ok('camera stream displays')

  await tab('Files')
  await page.getByText('benchy.gcode').first().waitFor()
  await page.getByText('bracket.gcode').waitFor()
  ok('lists files and print history')

  const big = Buffer.alloc(2_600_000, 'G1 X10 Y10 E1\n')
  writeFileSync(`${out}/widget.gcode`, big)
  await page.locator('input[type=file]').setInputFiles(`${out}/widget.gcode`)
  await page.locator('.item .name', { hasText: 'widget.gcode' }).waitFor({ timeout: 20000 })
  if (!printerLog.includes('upload complete widget.gcode 2600000 md5 ok')) throw new Error('printer did not verify the upload')
  ok(`uploads a 2.6 MB file in chunks; printer verified size and MD5 (${process.env.CORS === '1' ? 'readable replies' : 'unreadable cross-origin replies'})`)
  await shot('files')

  await page.locator('.item', { hasText: 'benchy.gcode' }).first().getByRole('button', { name: 'Print' }).click()
  await page.getByRole('button', { name: 'Start print' }).click()
  await tab('Status')
  await page.locator('.chip', { hasText: /Preheating|Auto-levelling/ }).waitFor()
  await page.locator('.chip', { hasText: 'Printing' }).waitFor({ timeout: 30000 })
  ok('starts a print and follows preheating, levelling, printing')
  await page.waitForFunction(() => parseInt(document.querySelector('.pct')?.textContent ?? '0') >= 5, null, { timeout: 30000 })
  await shot('status-printing')

  await tab('Control')
  const z = page.locator('section', { hasText: 'Z offset' }).locator('b.num').first()
  await page.getByRole('button', { name: '+0.01' }).click()
  await page.waitForFunction(() => document.body.textContent.includes('0.425 mm'), null, { timeout: 8000 })
  ok(`Z offset changes during a print and is read back (${await z.textContent()})`)
  await page.getByRole('button', { name: 'Sport' }).click()
  await page.locator('button.on', { hasText: 'Sport' }).waitFor()
  await page.getByRole('button', { name: /Chamber light/ }).click()
  await page.getByText('Chamber light: on').waitFor()
  await page.locator('section', { hasText: 'Temperatures' }).getByRole('button', { name: '250°' }).click()
  await page.getByText('/ 250 °C').waitFor()
  ok('speed mode, light and nozzle temperature change mid-print')
  await page.waitForTimeout(2600)
  await shot('control')

  await tab('Status')
  await page.getByRole('button', { name: 'Pause' }).click()
  await page.locator('.chip', { hasText: 'Paused' }).waitFor()
  await page.getByRole('button', { name: 'Resume' }).click()
  await page.locator('.chip', { hasText: 'Printing' }).waitFor()
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.locator('.chip', { hasText: 'Stopped' }).waitFor()
  ok('pause, resume and stop')

  await tab('Console')
  await page.getByRole('button', { name: 'Everything' }).click()
  await page.getByText('Cmd 128').first().waitFor()
  await page.getByRole('button', { name: 'Activity' }).click()
  await shot('console')
  ok('console narrates commands and replies')

  await tab('Care')
  await page.getByText('Check belt tension').waitFor()
  await shot('care')
  ok('maintenance screen')

  const wide = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  await wide.goto('http://127.0.0.1:4173/')
  await wide.getByPlaceholder('192.168.1.50').fill('127.0.0.1')
  await wide.getByRole('button', { name: 'Save and connect' }).click()
  await wide.locator('.chip', { hasText: /Stopped|Idle/ }).waitFor()
  await wide.waitForFunction(() => document.querySelector('.cam img')?.naturalWidth > 0)
  await wide.screenshot({ path: `${out}/desktop.png` })
  ok('desktop layout')
} catch (e) {
  failed = true
  console.error('FAIL after:', steps.at(-1), '\n', e.message)
  console.error(printerLog.slice(-1500))
} finally {
  await browser.close()
  procs.forEach((p) => p.kill())
}
process.exit(failed ? 1 : 0)
