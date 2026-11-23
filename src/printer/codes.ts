// Code tables for the Elegoo SDCP protocol on the Centauri Carbon.
// Sources: ELEGOO-3D/elegoo-link (Apache-2.0) message adapter enums,
// danielcherubini/elegoo-homeassistant (MIT) enums, OpenCentauri docs.
import type { Phase } from './types'

/** PrintInfo.Status -> [phase, label] */
export const PRINT_STATUS: Record<number, [Phase, string]> = {
  0: ['idle', 'Idle'],
  1: ['preparing', 'Homing'],
  5: ['pausing', 'Pausing'],
  6: ['paused', 'Paused'],
  7: ['stopping', 'Stopping'],
  8: ['stopped', 'Stopped'],
  9: ['complete', 'Print complete'],
  10: ['preparing', 'Checking file'],
  11: ['preparing', 'Checking printer'],
  12: ['resuming', 'Resuming'],
  13: ['printing', 'Printing'],
  14: ['error', 'Error'],
  15: ['preparing', 'Auto-levelling'],
  16: ['preparing', 'Preheating'],
  17: ['preparing', 'Resonance test'],
  18: ['preparing', 'Starting print'],
  19: ['preparing', 'Levelling done'],
  20: ['preparing', 'Preheat done'],
  21: ['preparing', 'Homing done'],
  22: ['preparing', 'Resonance test done'],
  23: ['preparing', 'Feeding filament'],
  24: ['preparing', 'Unloading filament'],
  25: ['error', 'Filament unload failed'],
  26: ['paused', 'Paused during unload'],
}

/** CurrentStatus[] (machine status) -> [phase, label], used when no job is active. */
export const MACHINE_STATUS: Record<number, [Phase, string]> = {
  0: ['idle', 'Idle'],
  1: ['printing', 'Printing'],
  2: ['busy', 'Receiving file'],
  4: ['busy', 'Self-check'],
  5: ['busy', 'Auto-levelling'],
  6: ['busy', 'Resonance test'],
  7: ['busy', 'Busy'],
  8: ['busy', 'Checking file'],
  9: ['busy', 'Homing'],
  10: ['busy', 'Loading / unloading filament'],
  11: ['busy', 'PID tuning'],
  12: ['busy', 'Recovering'],
}

export const START_ACK: Record<number, string> = {
  1: 'The printer says it is busy. If the last print finished, it may be waiting for "print complete" to be acknowledged on the touchscreen.',
  2: 'The printer could not find that file. Refresh the file list and try again.',
  3: 'The file failed its checksum on the printer. Upload it again.',
  4: 'The printer could not read the file (storage error). Check free space or re-upload.',
  5: 'The file does not match this printer (resolution mismatch).',
  6: 'The printer does not recognise this file format. It needs a .gcode file sliced for the Centauri Carbon.',
  7: 'The file was sliced for a different printer model.',
}

export const PRINT_ERROR_NUMBER: Record<number, string> = {
  1: 'File checksum failed. Upload the file again.',
  2: 'The printer could not read the file.',
  3: 'File does not match this printer (resolution).',
  4: 'File format not recognised.',
  5: 'File was sliced for a different printer model.',
}

/** ErrorStatusReason in history details. */
export const ERROR_REASON: Record<number, string> = {
  1: 'Over-temperature',
  3: 'Filament ran out',
  6: 'Filament jam',
  7: 'Bed levelling failed',
  12: 'USB drive removed',
  13: 'X homing failed',
  14: 'Z homing failed',
  17: 'Homing failed',
  18: 'Print came off the bed',
  19: 'General error',
  20: 'Abnormal movement',
  23: 'Y homing failed',
  24: 'G-code file error',
  25: 'Camera error',
  26: 'Network error',
  27: 'Server connection failed',
  28: 'App disconnected',
  33: 'Nozzle temperature sensor offline',
  34: 'Bed temperature sensor offline',
  45: 'Filament about to run out',
}

/** Codes shown on the Centauri Carbon touchscreen (from Elegoo's firmware source). */
export const SCREEN_ERRORS: { code: number; meaning: string; check: string }[] = [
  { code: 101, meaning: 'Heated bed did not heat up as expected', check: 'Bed cable and connector, room draughts, then power cycle.' },
  { code: 102, meaning: 'Heated bed thermistor read error', check: 'Bed thermistor cable seated at the mainboard.' },
  { code: 103, meaning: 'Printhead did not heat up as expected', check: 'Hotend heater and toolhead cable; part fan blowing on the block.' },
  { code: 104, meaning: 'Printhead thermistor read error', check: 'Toolhead cable (a known wear item) and hotend connector.' },
  { code: 302, meaning: 'X homing failed', check: 'Obstructions on the X rail, belt tension, toolhead cable snagging.' },
  { code: 303, meaning: 'Y homing failed', check: 'Obstructions on the Y rails, belt tension.' },
  { code: 304, meaning: 'Z homing failed', check: 'Debris under the bed, Z lead screws clean and lubricated.' },
  { code: 401, meaning: 'Accelerometer error (X)', check: 'Toolhead cable seated; power cycle.' },
  { code: 402, meaning: 'Accelerometer error (Y)', check: 'Toolhead cable seated; power cycle.' },
  { code: 502, meaning: 'Levelling sensor abnormal', check: 'Clean the nozzle tip and build plate, remove debris under the plate, re-run levelling.' },
  { code: 701, meaning: 'Mainboard fan abnormal', check: 'Fan spins freely and is plugged in.' },
  { code: 702, meaning: 'Heat-break fan abnormal', check: 'Hotend fan spins freely; clear filament strings.' },
  { code: 703, meaning: 'Model (part) fan abnormal', check: 'Part fan spins freely; clear filament strings.' },
]

export const UPLOAD_ERRORS: Record<string, string> = {
  '-1': 'offset error',
  '-2': 'offset mismatch (a previous upload of this file may still be open)',
  '-3': 'the printer could not open the file for writing (storage full?)',
  '-4': 'unknown error on the printer',
}
