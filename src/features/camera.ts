// The camera stream, shared by every place the picture can appear (Status card,
// floating player, pinned bar). There is exactly one <img> for the whole app and
// it is moved between those places, never recreated, because the printer allows
// only a few video viewers and can hold on to closed ones: every needless new
// connection uses up a slot.
//
// The stream is deliberately not restarted when the control connection drops and
// comes back: the video runs on its own port and usually survives a blip.
import { effect, signal } from '@preact/signals'
import { activeHost, backend, conn, log } from '../store'

export const camOn = signal(true)
export const camMsg = signal('Camera is off.')
export const camLive = signal(false) // a picture is showing

const img = typeof document !== 'undefined' ? document.createElement('img') : (null as unknown as HTMLImageElement)
let url = ''
let tries = 0
let retryTimer = 0
let starting = false
let hiddenAt = 0
let idleTimer = 0
const hosts: HTMLElement[] = []

if (img) {
  img.alt = 'Live view of the print'
  img.draggable = false
  img.onload = () => {
    tries = 0
    camLive.value = true
  }
  img.onerror = () => {
    if (!url) return // we cleared it ourselves
    stopStream()
    const n = ++tries
    if (n > 5) {
      const m = 'The camera stream keeps failing. The printer allows a handful of video viewers and can hold on to closed ones: close other viewers, or restart the printer when it is not printing.'
      log('error', `Camera: ${m}`)
      camMsg.value = m
      return
    }
    const wait = Math.min(30, 3 * n)
    camMsg.value = `Camera stream dropped. Retrying in ${wait}s (attempt ${n} of 5).`
    log('warn', `Camera stream dropped; retry ${n}/5 in ${wait}s.`)
    retryTimer = window.setTimeout(() => void startStream(), wait * 1000)
  }
}

/** The element to put on screen. Callers attach it with `attachCamera`. */
export function cameraElement() {
  return img
}

function stopStream() {
  url = ''
  camLive.value = false
  img?.removeAttribute('src')
}

async function startStream() {
  clearTimeout(retryTimer)
  const b = backend.value
  if (!b || starting || url || !camOn.value || conn.value !== 'connected' || !hosts.length) return
  starting = true
  camMsg.value = 'Starting the camera…'
  try {
    const u = await b.cameraUrl()
    if (!u) camMsg.value = 'The demo printer has no camera.'
    else if (camOn.value && hosts.length) {
      url = u
      img.src = u
    }
  } catch (e) {
    const m = (e as Error).message
    log('error', `Camera: ${m}`)
    camMsg.value = m
  } finally {
    starting = false
  }
}

/** Start over: used by the Retry button and after the app was in the background. */
export function restartCamera() {
  tries = 0
  stopStream()
  void startStream()
}

/** Show the stream inside `el`. Returns a detach function. */
export function attachCamera(el: HTMLElement) {
  hosts.push(el)
  el.appendChild(img)
  clearTimeout(idleTimer)
  void startStream()
  return () => {
    const i = hosts.indexOf(el)
    if (i >= 0) hosts.splice(i, 1)
    const last = hosts[hosts.length - 1]
    if (last) last.appendChild(img)
    else {
      img.remove()
      // Nobody is looking: free the printer's video slot after a short grace,
      // so switching tabs quickly does not reconnect the stream.
      idleTimer = window.setTimeout(() => !hosts.length && stopStream(), 20_000)
    }
  }
}

// Printer address changed: the old stream is for the wrong printer.
let lastHost = ''
effect(() => {
  const h = activeHost.value
  if (h === lastHost) return
  lastHost = h
  tries = 0
  stopStream()
})

effect(() => {
  const on = camOn.value
  const connected = conn.value === 'connected'
  if (!on) {
    clearTimeout(retryTimer)
    stopStream()
    camMsg.value = 'Camera is off.'
  } else if (connected) void startStream()
  else if (!url) camMsg.value = 'Waiting for the printer.'
})

if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now()
    // Android freezes the page in the background; a stream that sat frozen for a
    // while usually does not resume by itself, so open it again.
    else if (url && hiddenAt && Date.now() - hiddenAt > 15_000) restartCamera()
  })
