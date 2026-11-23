import { useEffect, useState } from 'preact/hooks'
import type { FileEntry, HistoryEntry, StartOptions } from '../printer/types'
import { act, backend, conn, info, log, state } from '../store'
import { Bar, duration, size } from './bits'

export function Files() {
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [upload, setUpload] = useState<{ name: string; fraction: number } | null>(null)
  const [pick, setPick] = useState<FileEntry | null>(null)
  const connected = conn.value === 'connected'
  const caps = backend.value?.caps
  const busy = ['preparing', 'printing', 'pausing', 'paused', 'resuming', 'stopping'].includes(state.value.phase)

  const reload = async () => {
    const b = backend.value
    if (!b || !connected) return
    try {
      setFiles(await b.listFiles())
    } catch (e) {
      log('error', `Could not read the file list. ${(e as Error).message}`)
    }
    b.history().then(setHistory, () => setHistory([]))
  }
  useEffect(() => void reload(), [connected])

  const send = async (file: File | undefined) => {
    if (!file) return
    if (!/\.gcode$/i.test(file.name) && !confirm(`${file.name} is not a .gcode file. Send it anyway?`)) return
    setUpload({ name: file.name, fraction: 0 })
    await act(`Upload ${file.name}`, (b) => b.upload(file, (fraction) => setUpload({ name: file.name, fraction })))
    setUpload(null)
    reload()
  }

  if (!connected) return <div class="card"><p class="dim">Connect to a printer to manage files.</p></div>
  return (
    <>
      <section class="card">
        <div class="spread">
          <h2>Send a file to the printer</h2>
        </div>
        {upload ? (
          <>
            <div class="spread"><span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{upload.name}</span><b class="num">{Math.round(upload.fraction * 100)}%</b></div>
            <Bar value={upload.fraction * 100} live />
          </>
        ) : (
          <label class="btn primary block">
            Choose a G-code file
            <input type="file" accept=".gcode,.gco,.g,text/plain,application/octet-stream" hidden onChange={(e) => (send(e.currentTarget.files?.[0]), (e.currentTarget.value = ''))} />
          </label>
        )}
        <p class="dim small">Slice for the Centauri Carbon in your slicer, export the G-code, then send it here. The file is sent in 1 MB pieces and checked by the printer.</p>
      </section>

      <section class="card wide">
        <div class="spread">
          <h2>On the printer</h2>
          <div class="row tight">
            {info.value?.freeBytes !== undefined && <span class="dim small num">{(info.value.freeBytes / 1e9).toFixed(1)} GB free</span>}
            <button class="btn sm" onClick={reload}>Refresh</button>
          </div>
        </div>
        <div class="list">
          {files === null && <p class="dim">Loading…</p>}
          {files?.length === 0 && <p class="dim">No files on the printer yet.</p>}
          {files?.map((f) => (
            <div class="item" key={f.path}>
              <div>
                <div class="name">{f.name}</div>
                <div class="dim small num">{size(f.size)}{f.layers ? ` · ${f.layers} layers` : ''}{f.modified ? ` · ${new Date(f.modified * 1000).toLocaleDateString()}` : ''}</div>
              </div>
              <div class="row">
                <button class="btn sm primary" disabled={busy} onClick={() => setPick(f)}>Print</button>
                <button class="btn sm danger" onClick={async () => confirm(`Delete ${f.name} from the printer?`) && (await act(`Delete ${f.name}`, (b) => b.deleteFile(f))) && reload()}>Delete</button>
              </div>
            </div>
          ))}
        </div>
        {busy && <p class="dim small">Printing is disabled while a job is running.</p>}
      </section>

      <section class="card third">
        <h2>Recent prints</h2>
        <div class="list">
          {history?.length === 0 && <p class="dim">No history yet.</p>}
          {history?.map((h) => (
            <div class="item" key={h.id}>
              {h.thumb && <img class="thumb" src={h.thumb} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = 'none')} />}
              <div class="spread">
                <span class="name">{h.name || 'Unnamed job'}</span>
                <span class={`chip ${h.outcome === 'completed' ? 'complete' : h.outcome === 'failed' ? 'error' : ''}`}>{h.outcome}</span>
              </div>
              <div class="dim small num">
                {h.begin ? new Date(h.begin * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''}
                {h.seconds || h.end > h.begin ? ` · ${duration(h.seconds ?? h.end - h.begin)}` : ''}
                {h.reason ? ` · ${h.reason}` : ''}
              </div>
            </div>
          ))}
        </div>
      </section>

      {pick && <StartDialog file={pick} options={!!caps?.startOptions} onClose={() => setPick(null)} />}
    </>
  )
}

function StartDialog({ file, options, onClose }: { file: FileEntry; options: boolean; onClose: () => void }) {
  const [o, setO] = useState<StartOptions>({ levelling: true, timelapse: false, plateSide: 0 })
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="card">
        <b>Print {file.name}?</b>
        <p class="dim small">Check the build plate is clear and filament is loaded.</p>
        {options && (
          <>
            <label class="check"><input type="checkbox" checked={o.levelling} onChange={(e) => setO({ ...o, levelling: e.currentTarget.checked })} /> Auto bed levelling before printing</label>
            <label class="check"><input type="checkbox" checked={o.timelapse} onChange={(e) => setO({ ...o, timelapse: e.currentTarget.checked })} /> Record a timelapse</label>
            <label class="field">Build plate side (each side has its own Z offset)
              <select value={o.plateSide} onChange={(e) => setO({ ...o, plateSide: +e.currentTarget.value as 0 | 1 })}>
                <option value={0}>Side A (textured)</option>
                <option value={1}>Side B (smooth)</option>
              </select>
            </label>
          </>
        )}
        <div class="row">
          <button class="btn grow" onClick={onClose}>Cancel</button>
          <button class="btn primary grow" onClick={() => (act(`Start ${file.name}`, (b) => b.start(file, o)), onClose())}>Start print</button>
        </div>
      </div>
    </div>
  )
}
