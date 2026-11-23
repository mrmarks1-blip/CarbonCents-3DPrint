// Stuck-state assistant: looks at how long the printer has been in its current
// situation and explains what is probably wrong and what can be tried.
// Rules come from failure reports on the Elegoo and OpenCentauri issue trackers.
import type { Capabilities, PrinterState } from '../printer/types'

export type ActionId = 'retry' | 'switchHost' | 'refresh' | 'pause' | 'resume' | 'stop' | 'heatersOff' | 'reheat' | 'firmwareRestart'

export interface Issue {
  id: string
  level: 'info' | 'warn' | 'bad'
  title: string
  why: string
  tips: string[]
  actions: ActionId[]
}

export interface Context {
  now: number
  conn: 'idle' | 'connecting' | 'connected' | 'closed'
  /** Consecutive failed connection attempts. */
  failures: number
  hasFallback: boolean
  backend: 'sdcp' | 'moonraker' | 'demo' | null
  state: PrinterState
  caps: Capabilities | null
  /** When phase+detail last changed. */
  phaseSince: number
  /** When elapsed time or layer last advanced. */
  progressSince: number
  /** When a heater last got closer to its target. */
  heatSince: number
  /** Nozzle target last seen while printing (for reheating after a pause). */
  printNozzleTarget: number
}

const MIN = 60_000
const POWER_CYCLE = 'If nothing responds, switch the printer off for 10 seconds and on again. This abandons the current print.'
const SSH_RESTART = 'On OpenCentauri-patched firmware the control process can be restarted over SSH (root / OpenCentauri): setsid nohup /app/app </dev/null >/tmp/app.log 2>&1 &'

export function diagnose(c: Context): Issue[] {
  const out: Issue[] = []
  const s = c.state
  const inPhase = c.now - c.phaseSince
  const mins = (ms: number) => Math.round(ms / MIN)

  if (c.conn !== 'connected') {
    if (c.failures >= 2)
      out.push({
        id: 'no-connection',
        level: 'bad',
        title: 'Cannot reach the printer',
        why: `${c.failures} connection attempts in a row have failed.`,
        tips: [
          'Check the printer is on and the address in Settings matches the one on its touchscreen (Settings > Network).',
          c.backend === 'moonraker'
            ? 'On COSMOS, "Waiting for Klipper" after boot can take a minute or two.'
            : 'The printer accepts only about 5 connections and does not release dead ones. Close the Elegoo web page, the slicer\'s device tab and any Home Assistant integration, then retry.',
          'If the printer\'s own web page is also dead, its control process has crashed (ports 80, 3030 and 3031 all stop). ' + POWER_CYCLE,
          ...(c.backend === 'sdcp' ? [SSH_RESTART] : []),
          'Away from home, the printer is only reachable through your VPN: check it is connected.',
        ],
        actions: c.hasFallback ? ['retry', 'switchHost'] : ['retry'],
      })
    return out
  }

  if (s.lastUpdate && c.now - s.lastUpdate > 20_000)
    out.push({
      id: 'silent',
      level: 'warn',
      title: 'The printer has stopped sending status',
      why: `Connected, but no status for ${Math.round((c.now - s.lastUpdate) / 1000)}s. What is shown may be out of date.`,
      tips: ['The control process may be busy (for example writing a large upload) or hung.', POWER_CYCLE],
      actions: ['refresh', 'retry'],
    })

  if (s.phase === 'error')
    out.push({
      id: 'error',
      level: 'bad',
      title: s.detail || 'The printer reports an error',
      why: s.error ?? 'No further detail was sent. The touchscreen shows the error code; look it up under Console > Error codes.',
      tips: ['Clear the error on the touchscreen before starting another print.'],
      actions: c.caps?.firmwareRestart ? ['firmwareRestart', 'refresh'] : ['refresh'],
    })

  if (s.phase === 'preparing') {
    const heating = s.temps.nozzle < s.temps.nozzleTarget - 3 || s.temps.bed < s.temps.bedTarget - 3
    if (heating && c.now - c.heatSince > 4 * MIN)
      out.push({
        id: 'not-heating',
        level: 'bad',
        title: 'Heating has stalled',
        why: `Nozzle ${s.temps.nozzle.toFixed(0)}/${s.temps.nozzleTarget} °C, bed ${s.temps.bed.toFixed(0)}/${s.temps.bedTarget} °C, with no rise for ${mins(c.now - c.heatSince)} minutes.`,
        tips: ['The touchscreen will usually show code 101 (bed) or 103 (nozzle).', 'A loose toolhead cable is the common cause for the nozzle; check both ends.', 'Stop the print before touching anything.'],
        actions: ['stop', 'refresh'],
      })
    else if (!heating && inPhase > 12 * MIN)
      out.push({
        id: 'stuck-preparing',
        level: 'warn',
        title: `Stuck on "${s.detail}" for ${mins(inPhase)} minutes`,
        why: 'Preparation normally takes under 10 minutes once temperatures are reached. Known causes: a freeze at the end of bed levelling, the printer waiting for the bed to cool to 60 °C before levelling, or running out of memory when a print is started straight after the last one.',
        tips: ['Stop is often accepted but ignored during levelling; sending it again after levelling ends can work.', 'Check the touchscreen for a prompt waiting for an answer.', POWER_CYCLE],
        actions: ['stop', 'refresh'],
      })
  }

  if (s.phase === 'pausing' && inPhase > 3 * MIN)
    out.push({
      id: 'stuck-pausing',
      level: 'warn',
      title: `Still "pausing" after ${mins(inPhase)} minutes`,
      why: 'A pause should complete within a minute. Pauses triggered by G-code in the file (PAUSE / M600) are known to hang on some firmware versions.',
      tips: ['Sending Pause again, then Resume, sometimes unblocks it.', 'Check the touchscreen for a filament-load prompt.', POWER_CYCLE],
      actions: ['pause', 'resume', 'stop'],
    })

  if (s.phase === 'paused') {
    if (s.temps.nozzleTarget === 0 && c.printNozzleTarget > 0)
      out.push({
        id: 'paused-cold',
        level: 'warn',
        title: 'Paused with the nozzle heater off',
        why: `The nozzle target has dropped to 0 °C. Resuming now fails with a temperature error; reheat to ${c.printNozzleTarget} °C first.`,
        tips: ['Wait for the nozzle to reach temperature before pressing Resume.'],
        actions: ['reheat', 'resume'],
      })
    if (inPhase > 30 * MIN)
      out.push({
        id: 'long-pause',
        level: 'info',
        title: `Paused for ${mins(inPhase)} minutes`,
        why: 'Long pauses on this printer are associated with a layer shift of about 2 mm on resume, and the part can come loose as the bed cools.',
        tips: ['Resume as soon as you can, and watch the first layers after resuming.'],
        actions: ['resume', 'stop'],
      })
  }

  if ((s.phase === 'stopping' || s.phase === 'resuming') && inPhase > 4 * MIN)
    out.push({
      id: `stuck-${s.phase}`,
      level: 'warn',
      title: `Still "${s.phase}" after ${mins(inPhase)} minutes`,
      why: s.phase === 'stopping' ? 'The printer has not confirmed the stop. It may be waiting for a move or for levelling to finish.' : 'Resume has not completed. The printer may report "another operation in progress" if a filament load is pending.',
      tips: ['Check the touchscreen for a prompt.', POWER_CYCLE],
      actions: s.phase === 'stopping' ? ['stop', 'refresh'] : ['resume', 'stop'],
    })

  if (s.phase === 'printing' && s.job.elapsed > 0 && c.now - c.progressSince > 6 * MIN)
    out.push({
      id: 'stalled',
      level: 'warn',
      title: 'Print time has stopped advancing',
      why: `Reported as printing, but neither time nor layer has moved for ${mins(c.now - c.progressSince)} minutes. The printer may be paused for a filament runout without saying so, or waiting on a touchscreen prompt.`,
      tips: ['Look at the camera: is the head moving?', 'If the head is moving, this is only a reporting fault.'],
      actions: ['refresh', 'pause', 'stop'],
    })

  const idleLike = s.phase === 'idle' || s.phase === 'complete' || s.phase === 'stopped'
  if (idleLike && (s.temps.nozzleTarget > 0 || s.temps.bedTarget > 0) && inPhase > 30 * MIN)
    out.push({
      id: 'idle-hot',
      level: 'info',
      title: 'Heaters are on with nothing printing',
      why: `Nozzle target ${s.temps.nozzleTarget} °C, bed target ${s.temps.bedTarget} °C for over ${mins(inPhase)} minutes. Some firmware versions leave the hotend on after loading filament.`,
      tips: [],
      actions: ['heatersOff'],
    })

  if (s.phase === 'complete' && s.job.filename)
    out.push({
      id: 'ack-complete',
      level: 'info',
      title: 'Print finished',
      why: 'Remove the part. The printer may refuse the next job as "busy" until the finished print is acknowledged on its touchscreen.',
      tips: [],
      actions: [],
    })

  return out
}
