import { useState } from 'react';
import { type EditorProps, replaceAt, removeAt } from './common';
import '../../styles.css';

const EVENT_KINDS = ['incident', 'change', 'deployment', 'alert', 'observation', 'other'];

export function Timeline({ data, set, readOnly: locked }: EditorProps) {
  const events: { at: string; kind: string; description: string; reference: string }[] = data.events ?? [];
  const [editing, setEditing] = useState(events.length === 0);
  const readOnly = locked || !editing;
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.at.localeCompare(b.e.at));
  const add = () => set({ ...data, events: [...events, { at: new Date().toISOString().slice(0, 16), kind: 'observation', description: '', reference: '' }] });
  return (
    <div className="timeline">
      {sorted.length === 0 && <p className="placeholder">No events yet.</p>}
      <ol className="tl">
        {sorted.map(({ e, i }) => (
          <li key={i} className={`tl-${e.kind}`}>
            <span className="tl-dot" />
            {readOnly ? (
              <div className="tl-view">
                <div className="tl-meta"><time>{e.at.replace('T', ' ')}</time><span className="tag">{e.kind}</span>{e.reference && <span className="mono small">{e.reference}</span>}</div>
                <div>{e.description}</div>
              </div>
            ) : (
              <div className="tl-edit">
                <input type="datetime-local" value={e.at} onChange={(ev) => set({ ...data, events: replaceAt(events, i, { ...e, at: ev.target.value }) })} />
                <select value={e.kind} onChange={(ev) => set({ ...data, events: replaceAt(events, i, { ...e, kind: ev.target.value }) })}>
                  {EVENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <input placeholder="Reference" value={e.reference} onChange={(ev) => set({ ...data, events: replaceAt(events, i, { ...e, reference: ev.target.value }) })} />
                <input className="tl-desc" placeholder="What happened" value={e.description} onChange={(ev) => set({ ...data, events: replaceAt(events, i, { ...e, description: ev.target.value }) })} />
                <button className="btn-icon small" aria-label="Remove event" onClick={() => set({ ...data, events: removeAt(events, i) })}>×</button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {!locked && (
        <div className="row-actions">
          {editing && <button className="btn-link small" onClick={add}>+ Event</button>}
          {events.length > 0 && <button className="btn-link small" onClick={() => setEditing(!editing)}>{editing ? 'Done editing' : 'Edit events'}</button>}
        </div>
      )}
    </div>
  );
}
