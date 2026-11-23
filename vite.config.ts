import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './', // works from any folder on a LAN web server and inside the Android app
  plugins: [preact()],
})
