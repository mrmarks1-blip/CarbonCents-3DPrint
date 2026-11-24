// Filament colour tuning for the camera picture. Everything here changes the
// picture in the app only (an SVG colour-matrix filter on the image); nothing is
// sent to the printer.
//
// Two layers:
// - A per-colour preset of red / green / blue gains that helps that filament
//   stand out (lift shadows for black, tame highlights for white, and so on).
//   The R / G / B sliders adjust these gains and are remembered per colour.
// - "Highlight": a colour-splash effect. Everything is turned grey except
//   colours close to the filament's, which are boosted, so stray strands of
//   spaghetti stand out. Only meaningful for coloured filaments.

export interface FilamentPreset {
  id: string
  label: string
  hex: string
  /** Default R, G, B gains in percent. */
  gains: [number, number, number]
  /** Added to every channel, in 0..1 units (lifts or lowers the whole picture). */
  lift: number
}

export const PRESETS: FilamentPreset[] = [
  { id: 'white', label: 'White', hex: '#f4f4f4', gains: [85, 85, 85], lift: -0.02 },
  { id: 'grey', label: 'Grey', hex: '#8a8f98', gains: [115, 115, 115], lift: 0 },
  { id: 'black', label: 'Black', hex: '#1d1f23', gains: [160, 160, 160], lift: 0.05 },
  { id: 'red', label: 'Red', hex: '#e0322e', gains: [125, 90, 90], lift: 0 },
  { id: 'orange', label: 'Orange', hex: '#ff7a1a', gains: [120, 105, 85], lift: 0 },
  { id: 'yellow', label: 'Yellow', hex: '#f5cf1f', gains: [115, 115, 80], lift: 0 },
  { id: 'green', label: 'Green', hex: '#2fb457', gains: [90, 125, 90], lift: 0 },
  { id: 'blue', label: 'Blue', hex: '#2f6fe0', gains: [90, 95, 130], lift: 0 },
  { id: 'purple', label: 'Purple', hex: '#8e44c9', gains: [115, 85, 125], lift: 0 },
]

export interface FilamentSettings {
  /** 'none', a preset id, or 'custom'. */
  pick: string
  /** Colour used for 'custom'. */
  custom: string
  highlight: boolean
  /** Slider adjustments per colour, R / G / B gains in percent. */
  tweaks: Record<string, [number, number, number]>
}

export const defaultFilament = (): FilamentSettings => ({ pick: 'none', custom: '#ff7a1a', highlight: false, tweaks: {} })

export const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0.5, 0.5, 0.5]
}

/** How coloured a colour is, 0 (grey) to about 0.8. Highlight needs some. */
export function chroma(hex: string) {
  const [r, g, b] = hexToRgb(hex)
  const m = (r + g + b) / 3
  return Math.hypot(r - m, g - m, b - m)
}
export const canHighlight = (hex: string) => chroma(hex) > 0.12

/** The colour and default gains for what is picked; null for no tuning. */
export function resolve(f: FilamentSettings): { hex: string; gains: [number, number, number]; lift: number; key: string } | null {
  if (f.pick === 'none') return null
  const p = PRESETS.find((x) => x.id === f.pick)
  const base = p ?? { hex: f.custom, gains: [100, 100, 100] as [number, number, number], lift: 0 }
  const key = p ? p.id : 'custom'
  return { hex: base.hex, gains: f.tweaks[key] ?? base.gains, lift: base.lift, key }
}

const LUMA = [0.2126, 0.7152, 0.0722]

/**
 * feColorMatrix values (20 numbers each) for the filter chain, or null when
 * nothing is picked. `[gain]` alone, or `[gain, measure, splash]` with Highlight.
 */
export function matrices(f: FilamentSettings): string[] | null {
  const r = resolve(f)
  if (!r) return null
  const [gr, gg, gb] = r.gains.map((g) => g / 100)
  const l = r.lift
  const gain = [gr, 0, 0, 0, l, 0, gg, 0, 0, l, 0, 0, gb, 0, l, 0, 0, 0, 1, 0]
  if (!f.highlight || !canHighlight(r.hex)) return [fmt(gain)]

  // Direction of the filament's colour away from grey, as a unit vector t.
  const c = hexToRgb(r.hex)
  const mean = (c[0] + c[1] + c[2]) / 3
  const d = c.map((v) => v - mean)
  const n = Math.hypot(...d) || 1
  const t = d.map((v) => v / n)
  // Step 1: R = how much of t the pixel has (t · pixel; t sums to 0 so grey
  // scores 0, and negatives clamp to 0, which drops opposite colours),
  // G = brightness. Filters clamp every step to 0..1.
  const k = 2.2
  const measure = [k * t[0], k * t[1], k * t[2], 0, 0, LUMA[0], LUMA[1], LUMA[2], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]
  // Step 2: out = brightness + amount * filament colour direction.
  const s = 0.75
  const splash = [s * t[0], 1, 0, 0, 0, s * t[1], 1, 0, 0, 0, s * t[2], 1, 0, 0, 0, 0, 0, 0, 1, 0]
  return [fmt(gain), fmt(measure), fmt(splash)]
}

const fmt = (m: number[]) => m.map((v) => +v.toFixed(4)).join(' ')
