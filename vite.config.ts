import preact from '@preact/preset-vite'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
let commit = (process.env.GITHUB_SHA ?? '').slice(0, 7)
try {
  commit ||= execSync('git rev-parse --short HEAD').toString().trim()
} catch {
  commit ||= 'local'
}

export default defineConfig({
  base: './', // works from any folder on a LAN web server and inside the Android app
  plugins: [preact()],
  // Shown in Settings, so you can tell which copy is installed.
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILD__: JSON.stringify(`${commit} · ${new Date().toISOString().slice(0, 10)}`) },
})
