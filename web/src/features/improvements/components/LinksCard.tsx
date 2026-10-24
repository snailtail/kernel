import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import type { Improvement, LinkRow } from '../../../api/types/improvements';
import { LINK_PATH } from '../common';

export function LinksCard({ m, editable, onChange }: { m: Improvement; editable: boolean; onChange: (fn: () => Promise<Improvement>) => Promise<boolean> }) {
  const [kind, setKind] = useState('change');
  const [reference, setReference] = useState('');
  const kernel = (x: LinkRow) => x.system === 'Kernel' || x.system === '';
  return (
    <section className="card">
      <h2>Carried out by <span className="count">{m.links.length}</span></h2>
      {m.links.length === 0 && <p className="placeholder">Link the changes, problems and actions that carry it out: the work happens there.</p>}
      <ul className="plain-list">
        {m.links.map((x) => {
          const to = kernel(x) ? LINK_PATH[x.kind]?.(x.reference, x) : null;
          const label = x.kind === 'action' ? `action #${x.reference}` : x.reference;
          return (
            <li key={x.id}>
              <span className="tag">{x.kind}</span>{' '}
              {to ? <Link to={to} className="mono">{label}</Link> : x.url ? <a href={x.url} target="_blank" rel="noreferrer">{label}</a> : <span className="mono">{label}</span>}
              {x.title && ` ${x.title}`} {x.status && <span className="muted small">{x.status.replace('_', ' ')}</span>}
              {x.note && <span className="muted small"> · {x.note}</span>}
              {editable && <button className="btn-link small" aria-label={`Remove link to ${label}`} onClick={() => onChange(() => api.del(`/api/improvements/${m.ref}/links/${x.id}`))}>Remove</button>}
            </li>
          );
        })}
      </ul>
      {editable && (
        <form className="rel-form small" onSubmit={async (e) => { e.preventDefault(); if (await onChange(() => api.post(`/api/improvements/${m.ref}/links`, { kind, reference: reference.trim() }))) setReference(''); }}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            <option value="change">Change</option><option value="problem">Problem</option><option value="action">Action (id)</option><option value="incident">Incident</option><option value="review">Review</option>
          </select>
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={kind === 'action' ? '12' : kind === 'change' ? 'CHG…' : kind === 'problem' ? 'PRB…' : kind === 'review' ? 'PIR…' : 'INC…'} aria-label="Reference" />
          <button className="btn small" disabled={!reference.trim()}>Link</button>
        </form>
      )}
    </section>
  );
}
