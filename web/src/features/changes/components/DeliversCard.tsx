import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import type { Change } from '../../../api/types/changes';
import { StatusBadge } from '../../../components/Badges';
import { TypeBadge } from '../../development/common';

/**
 * The bugs and stories a change delivers: its manifest (#167). Linked from here or from the work item; once the change
 * is implemented, the problems those bugs fix are followed up on their own page.
 */
export function DeliversCard({ change: c, editable, onChange }: { change: Change; editable: boolean; onChange: () => void }) {
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const items = c.work_items ?? [];
  const submit = async () => {
    setError('');
    try {
      await api.post(`/api/records/${c.ref}/links`, { to: reference.trim() });
      setReference('');
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Delivers <span className="count">{items.length || ''}</span></h2>
      {items.length === 0 && <p className="placeholder">The bugs and stories this change ships.</p>}
      <ul className="plain-list">
        {items.map((w) => (
          <li key={w.ref}>
            <TypeBadge type={w.item_type} /> <Link to={`/work/${w.ref}`} className="mono">{w.ref}</Link> {w.title} <StatusBadge kind="work_item" status={w.status} />
          </li>
        ))}
      </ul>
      {items.some((w) => w.status !== 'done') && <p className="muted small">Not done yet: the problem it fixes waits until every bug is done and the change is implemented.</p>}
      {editable && (
        <form className="rel-form small" onSubmit={(e) => { e.preventDefault(); if (reference.trim()) submit(); }}>
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="WI000123" aria-label="Work item to link" />
          <button className="btn small" type="submit" disabled={!reference.trim()}>Link</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
