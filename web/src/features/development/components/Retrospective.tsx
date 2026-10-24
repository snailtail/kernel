// The retrospective (#166): what went well, what was hard, and what to change. Something to change becomes an
// improvement (#52) with one click.
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import { useSession } from '../../../session';
import type { RetroKind, Sprint } from '../../../api/types/development';

const KINDS: { kind: RetroKind; label: string; hint: string }[] = [
  { kind: 'went_well', label: 'Went well', hint: 'Keep doing it' },
  { kind: 'hard', label: 'Was hard', hint: 'What slowed the team down' },
  { kind: 'to_change', label: 'To change', hint: 'One small change for the next sprint' },
];

export function Retrospective({ sprint, editable, onChanged }: { sprint: Sprint; editable: boolean; onChanged: () => void }) {
  const { user } = useSession();
  const [drafts, setDrafts] = useState<Record<RetroKind, string>>({ went_well: '', hard: '', to_change: '' });
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const add = (kind: RetroKind) => run(async () => {
    await api.post(`/api/sprints/${sprint.id}/retro`, { kind, body: drafts[kind] });
    setDrafts((d) => ({ ...d, [kind]: '' }));
  });
  return (
    <section className="card">
      <h2>Retrospective</h2>
      {error && <div className="error">{error}</div>}
      <div className="sp-retro">
        {KINDS.map(({ kind, label, hint }) => {
          const items = sprint.retrospective.filter((r) => r.kind === kind);
          return (
            <div key={kind} className={`sp-retro-col sp-retro-${kind}`}>
              <h3>{label} <span className="count">{items.length}</span></h3>
              <ul>
                {items.map((r) => (
                  <li key={r.id}>
                    <span className="sp-retro-body">{r.body}</span>
                    <span className="muted small">{r.created_by_name ?? 'Someone'}</span>
                    <span className="sp-retro-actions">
                      {r.improvement ? <Link to={`/improvements/${r.improvement}`} className="tag mono">{r.improvement}</Link>
                        : kind === 'to_change' && editable && <button type="button" className="btn small" onClick={() => run(() => api.post(`/api/sprints/${sprint.id}/retro/${r.id}/improvement`, {}))}>Make it an improvement</button>}
                      {editable && !r.improvement && (r.created_by === user.id || sprint.may_manage_retro) && (
                        <button type="button" className="btn small" onClick={() => run(() => api.del(`/api/sprints/${sprint.id}/retro/${r.id}`))} aria-label={`Remove "${r.body.slice(0, 40)}"`}>Remove</button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {editable && (
                <form className="sp-retro-add" onSubmit={(e) => { e.preventDefault(); if (drafts[kind].trim()) add(kind); }}>
                  <input value={drafts[kind]} onChange={(e) => setDrafts({ ...drafts, [kind]: e.target.value })} placeholder={hint} aria-label={`Add to ${label.toLowerCase()}`} maxLength={2000} />
                  <button className="btn small" disabled={!drafts[kind].trim()}>Add</button>
                </form>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
