import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import type { RecordTrace, TraceNode } from '../api/types/development';
import { formatDate } from '../format';
import { StatusBadge } from './Badges';
import { recordPath } from './History';
import { canEdit, useSession } from '../session';

/** The columns, in the order work flows: incidents to the problem, its bugs, the changes that ship them. */
const COLUMNS: { label: string; types: TraceNode['type'][] }[] = [
  { label: 'Incidents', types: ['incident'] },
  { label: 'Problems', types: ['problem'] },
  { label: 'Work items', types: ['work_item'] },
  { label: 'Changes', types: ['change'] },
  { label: 'Improvements and requests', types: ['improvement', 'request'] },
];

/**
 * The trace of a record (#167): everything linked to it, a few steps out, by kind. Not one chain: pointing at a record
 * highlights what it links to. A record the reader may not see shows as "a restricted record". `version` reloads it
 * when the record changes; `create` labels a button that makes a work item from it ("Create a bug").
 */
export function TraceCard({ recordRef, version, create }: { recordRef: string; version?: unknown; create?: string }) {
  const { user, meta } = useSession();
  const [trace, setTrace] = useState<RecordTrace | null>(null);
  const actions = create && meta.modules?.development && canEdit(user) ? <CreateWorkItemButton recordRef={recordRef} label={create} /> : null;
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => { api.get<RecordTrace>(`/api/records/${recordRef}/trace`).then(setTrace, () => setTrace(null)); }, [recordRef, version]);
  if (!trace || (trace.nodes.length < 2 && !actions)) return null;
  const near = new Set(focus ? [focus, ...trace.edges.flatMap((e) => (e.from === focus ? [e.to] : e.to === focus ? [e.from] : []))] : []);
  const columns = COLUMNS.map((c) => ({ ...c, nodes: trace.nodes.filter((n) => c.types.includes(n.type)) })).filter((c) => c.nodes.length);
  return (
    <section className="card trace">
      <h2>Trace <span className="count">{trace.nodes.length - 1 || ''}</span></h2>
      {trace.nodes.length < 2 && <p className="placeholder">Nothing linked yet: incidents, the problem, its bugs and the changes that ship them show here.</p>}
      {trace.nodes.length > 1 && (
        <div className="trace-columns" onMouseLeave={() => setFocus(null)}>
          {columns.map((c) => (
            <div key={c.label} className="trace-column">
              <h3>{c.label}</h3>
              <ul className="plain-list">
                {c.nodes.map((n) => (
                  <li key={n.id} className={`trace-node${n.id === trace.ref ? ' current' : ''}${focus && !near.has(n.id) ? ' faded' : ''}`}
                    onMouseEnter={() => setFocus(n.id)} onFocus={() => setFocus(n.id)}>
                    {n.restricted ? <span className="muted">A restricted record</span> : <Node n={n} current={n.id === trace.ref} />}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {trace.truncated && <p className="muted small">Only the nearest records are shown.</p>}
      {actions && <div className="trace-actions">{actions}</div>}
    </section>
  );
}

function Node({ n, current }: { n: TraceNode; current: boolean }) {
  const path = recordPath(n.ref!);
  return (
    <>
      <span className="trace-ref">
        {current || !path ? <span className="mono">{n.ref}</span> : <Link to={path} className="mono">{n.ref}</Link>}
        {n.item_type && <span className="tag">{n.item_type}</span>}
        {n.status && <StatusBadge kind={n.type} status={n.status as never} />}
      </span>
      <span className="trace-title">{n.title}</span>
      {n.created_at && <span className="muted small">{formatDate(n.created_at)}</span>}
    </>
  );
}

/** "Create a bug" or "Create a story" (#167): the new item is as narrow as the record, links back to it and opens. */
function CreateWorkItemButton({ recordRef, label }: { recordRef: string; label: string }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    try {
      navigate(`/work/${(await api.post<{ ref: string }>(`/api/records/${recordRef}/work-items`, {})).ref}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return <>
    <button className="btn small" onClick={create}>{label}</button>
    {error && <span className="error small">{error}</span>}
  </>;
}
