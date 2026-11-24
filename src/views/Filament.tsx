import { signal } from '@preact/signals'
import { PRESETS, canHighlight, matrices, resolve, type FilamentSettings } from '../features/filament'
import { settings } from '../store'

export const FILTER_ID = 'cc-filament'
/** Where to open the sheet: away from the camera, so the picture stays visible while tuning. */
export const sheetAt = signal<'top' | 'bottom' | null>(null)

const f = () => settings.value.filament
const setF = (patch: Partial<FilamentSettings>) => (settings.value = { ...settings.value, filament: { ...f(), ...patch } })

/** CSS filter prefix for the camera image ('' when no filament colour is picked). */
export const filamentCss = () => (matrices(f()) ? `url(#${FILTER_ID}) ` : '')

/** The SVG filter the camera image refers to. Rendered once, invisible. */
export function FilamentFilter() {
  const m = matrices(f())
  if (!m) return null
  return (
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
      <filter id={FILTER_ID} color-interpolation-filters="sRGB">
        {m.map((values) => <feColorMatrix type="matrix" values={values} />)}
      </filter>
    </svg>
  )
}

/** The small dot on the picture: shows the filament colour, opens the sheet. */
export function FilamentDot({ from }: { from: () => HTMLElement | null }) {
  const r = resolve(f())
  const open = () => {
    const box = from()?.getBoundingClientRect()
    sheetAt.value = box && box.top + box.height / 2 > innerHeight / 2 ? 'top' : 'bottom'
  }
  return (
    <button class="zbtn fdot" onClick={open} aria-label="Filament colour" title="Filament colour">
      <i style={{ background: r ? r.hex : 'transparent', borderStyle: r ? 'solid' : 'dashed' }} />
      {f().highlight && r && canHighlight(r.hex) && <b aria-hidden="true">✦</b>}
    </button>
  )
}

export function FilamentSheet() {
  const at = sheetAt.value
  if (!at) return null
  const cur = f()
  const r = resolve(cur)
  const gains = r?.gains ?? [100, 100, 100]
  const setGain = (i: number, v: number) => {
    if (!r) return
    const next = [...gains] as [number, number, number]
    next[i] = v
    setF({ tweaks: { ...cur.tweaks, [r.key]: next } })
  }
  const resetGains = () => {
    if (!r) return
    const { [r.key]: _, ...rest } = cur.tweaks
    setF({ tweaks: rest })
  }
  const highlightable = !!r && canHighlight(r.hex)

  return (
    <div class={`sheet at-${at}`} role="dialog" aria-label="Filament colour">
      <div class="spread">
        <b>Printing in</b>
        <button class="btn sm" onClick={() => (sheetAt.value = null)}>Done</button>
      </div>
      <div class="swatches">
        <button class={`sw none ${cur.pick === 'none' ? 'on' : ''}`} onClick={() => setF({ pick: 'none' })} aria-label="No colour tuning" title="Off" />
        {PRESETS.map((p) => (
          <button class={`sw ${cur.pick === p.id ? 'on' : ''}`} style={{ background: p.hex }} onClick={() => setF({ pick: p.id })} aria-label={p.label} title={p.label} />
        ))}
        <label class={`sw custom ${cur.pick === 'custom' ? 'on' : ''}`} style={{ background: cur.custom }} title="Custom colour">
          <input type="color" value={cur.custom} aria-label="Custom colour" onInput={(e) => setF({ pick: 'custom', custom: e.currentTarget.value })} onClick={() => setF({ pick: 'custom' })} />
        </label>
      </div>
      <label class="check small">
        <input type="checkbox" checked={cur.highlight} disabled={!highlightable} onChange={(e) => setF({ highlight: e.currentTarget.checked })} />
        <span>
          Highlight my filament <span class="dim">{highlightable ? '(greys out everything else, so stray strands stand out)' : '(needs a coloured filament)'}</span>
        </span>
      </label>
      {r && (
        <details class="fine">
          <summary>Fine tune</summary>
          {(['Red', 'Green', 'Blue'] as const).map((name, i) => (
            <label class="field">
              <span class="spread"><span>{name}</span><span class="num">{gains[i]}%</span></span>
              <input type="range" class={`ch-${name.toLowerCase()}`} min={50} max={200} step={5} value={gains[i]} onInput={(e) => setGain(i, +e.currentTarget.value)} />
            </label>
          ))}
          <div class="row">
            <button class="btn sm" onClick={resetGains}>Reset {r.key === 'custom' ? 'custom' : PRESETS.find((p) => p.id === r.key)?.label.toLowerCase()}</button>
            <span class="dim small">Remembered for this colour. Picture only; nothing is sent to the printer.</span>
          </div>
        </details>
      )}
    </div>
  )
}
