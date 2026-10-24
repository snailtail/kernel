import { Link } from 'react-router';
import { StatusBadge } from '../../../components/Badges';
import { formatDate } from '../../../format';
import { useApi } from '../../../hooks';
import type { ChangeRow } from '../../../api/types/changes';

export function Schedule() {
  const { data } = useApi<{ changes: (ChangeRow & { cis: string[] | null })[]; freezes: { id: number; name: string; starts_at: string; ends_at: string; reason: string }[]; collisions: { change: string; with: string; ci_name: string }[] }>('/api/changes/schedule');
  if (!data) return null;
  // Group by day of the planned start; freezes are shown above the days they cover.
  const days = new Map<string, typeof data.changes>();
  for (const c of data.changes) {
    const d = new Date(c.planned_start!).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    days.set(d, [...(days.get(d) ?? []), c]);
  }
  const colliding = new Set(data.collisions.map((c) => c.change));
  return (
    <>
      {data.freezes.map((f) => <p key={f.id} className="warn-box">Change freeze <strong>{f.name}</strong>: {formatDate(f.starts_at)} – {formatDate(f.ends_at)}{f.reason && ` · ${f.reason}`}</p>)}
      {days.size === 0 && <p className="empty">Nothing planned in the next 30 days.</p>}
      <div className="schedule">
        {[...days.entries()].map(([day, list]) => (
          <section key={day} className="card">
            <h2>{day}</h2>
            <ul className="work-list">
              {list.map((c) => (
                <li key={c.ref} className={colliding.has(c.ref) ? 'collides' : ''}>
                  <div>
                    <Link to={`/changes/${c.ref}`} className="mono">{c.ref}</Link> {c.title} <span className={`tag type-${c.change_type}`}>{c.change_type}</span>
                    <div className="muted small">{new Date(c.planned_start!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–{new Date(c.planned_end!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {c.cis?.join(', ') ?? 'no CIs'}</div>
                    {colliding.has(c.ref) && <div className="small attention">Collides with {data.collisions.filter((x) => x.change === c.ref).map((x) => `${x.with} on ${x.ci_name}`).join(', ')}</div>}
                  </div>
                  <StatusBadge kind="change" status={c.status} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
