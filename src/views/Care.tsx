import { useState } from 'preact/hooks'
import { freshTasks, remaining, usage, type Task } from '../features/maintenance'
import { log, printHours, tasks } from '../store'
import { Bar } from './bits'

export function Care() {
  const [edit, setEdit] = useState<Task | null>(null)
  const now = Date.now()
  const hours = printHours.value
  const sorted = [...tasks.value].sort((a, b) => usage(b, now, hours) - usage(a, now, hours))
  const done = (t: Task) => {
    tasks.value = tasks.value.map((x) => (x.id === t.id ? { ...x, lastDone: Date.now(), hoursAtLastDone: hours } : x))
    log('ok', `Maintenance logged: ${t.name}.`)
  }
  const saveTask = (t: Task) => {
    tasks.value = tasks.value.some((x) => x.id === t.id) ? tasks.value.map((x) => (x.id === t.id ? t : x)) : [...tasks.value, t]
    setEdit(null)
  }

  return (
    <>
      <section class="card third">
        <h2>Print hours</h2>
        <b class="num" style="font-size:2.2rem">{hours.toFixed(1)} h</b>
        <p class="dim small">Counted from the printer's job history and from prints seen while this app is open. Stored on this device.</p>
      </section>

      <section class="card wide">
        <div class="spread">
          <h2>Maintenance</h2>
          <button class="btn sm" onClick={() => setEdit({ id: `custom-${Date.now()}`, name: '', note: '', everyHours: 100, everyDays: 0, lastDone: Date.now(), hoursAtLastDone: hours })}>Add task</button>
        </div>
        <div class="list">
          {sorted.map((t) => {
            const u = usage(t, now, hours)
            return (
              <div class="item" key={t.id}>
                <div class="spread">
                  <span class="name" style="word-break:normal">{t.name}</span>
                  {u >= 1 && <span class="chip error">Due</span>}
                </div>
                <Bar value={u * 100} tone={u >= 1 ? 'bad' : u >= 0.8 ? 'warn' : 'ok'} thin />
                <div class="dim small">{remaining(t, now, hours)} · last done {new Date(t.lastDone).toLocaleDateString()}</div>
                {t.note && <div class="dim small">{t.note}</div>}
                <div class="row">
                  <button class="btn sm primary" onClick={() => done(t)}>Mark done</button>
                  <button class="btn sm" onClick={() => setEdit(t)}>Edit</button>
                </div>
              </div>
            )
          })}
        </div>
        <button class="btn sm" onClick={() => confirm('Reset all tasks to the defaults, as if done today?') && (tasks.value = freshTasks(Date.now(), hours))}>Reset to defaults</button>
      </section>

      {edit && <EditDialog task={edit} onSave={saveTask} onDelete={() => ((tasks.value = tasks.value.filter((x) => x.id !== edit.id)), setEdit(null))} onClose={() => setEdit(null)} />}
    </>
  )
}

function EditDialog({ task, onSave, onDelete, onClose }: { task: Task; onSave: (t: Task) => void; onDelete: () => void; onClose: () => void }) {
  const [t, setT] = useState(task)
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="card">
        <label class="field">Task<input type="text" value={t.name} onInput={(e) => setT({ ...t, name: e.currentTarget.value })} /></label>
        <label class="field">Every (print hours, 0 to ignore)<input type="number" min={0} value={t.everyHours} onInput={(e) => setT({ ...t, everyHours: Math.max(0, +e.currentTarget.value) })} /></label>
        <label class="field">Every (days, 0 to ignore)<input type="number" min={0} value={t.everyDays} onInput={(e) => setT({ ...t, everyDays: Math.max(0, +e.currentTarget.value) })} /></label>
        <label class="field">Note<input type="text" value={t.note} onInput={(e) => setT({ ...t, note: e.currentTarget.value })} /></label>
        <div class="row">
          <button class="btn danger" onClick={onDelete}>Delete</button>
          <button class="btn grow" onClick={onClose}>Cancel</button>
          <button class="btn primary grow" disabled={!t.name.trim()} onClick={() => onSave(t)}>Save</button>
        </div>
      </div>
    </div>
  )
}
