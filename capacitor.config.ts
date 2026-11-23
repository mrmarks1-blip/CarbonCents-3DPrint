import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.centauricontrol',
  appName: 'Centauri Control',
  webDir: 'dist',
  // The printer only speaks plain ws:// and http:// on the local network, so the
  // app's own page must be http too (an https page may not open ws:// links).
  server: { androidScheme: 'http', cleartext: true },
}

export default config
