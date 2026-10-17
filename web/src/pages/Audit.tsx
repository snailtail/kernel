import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { formatDate, relativeTime } from '../format';
import { useSession } from '../session';
import { ChangeList, recordPath, type AuditEntry } from '../components/History';

type Entry = AuditEntry;

const FILTERS = ['actor', 'actor_id', 'token_prefix', 'actor_type', 'entity_type', 'entity_ref', 'action', 'from', 'to', 'ip'] as const;
const ACTOR_TYPES = ['user', 'api_token', 'mcp', 'integration', 'system', 'anonymous'];
const ENTITY_TYPES = ['problem', 'user', 'session', 'api_token', 'webhook', 'setting', 'category', 'external_system', 'external_record', 'audit_log', 'ci', 'service', 'ci_type'];

export function AuditPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(() => Object.fromEntries(FILTERS.map((f) => [f, params.get(f) ?? ''])) as Record<string, string>);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; broken_at?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterQuery = new URLSearchParams(Object.fromEntries(FILTERS.filter((f) => params.get(f)).map((f) => [f, params.get(f)!])));

  const load = async (beforeId?: number) => {
    setError(null);
    try {
      const q = new URLSearchParams(filterQuery);
      q.set('limit', '100');
      if (beforeId) q.set('before_id', String(beforeId));
      const rows = await api.get<Entry[]>(`/api/audit?${q}`);
      setEntries((prev) => (beforeId ? [...prev, ...rows] : rows));
      setMore(rows.length === 100);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.toString()]);

  if (user.role !== 'admin') return <p className="empty">The audit trail is available to administrators.</p>;

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setParams(Object.fromEntries(Object.entries(draft).filter(([, v]) => v.trim())), { replace: true });
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Audit trail</h1>
          <p className="muted">Who did what, when, how and why — append-only and hash-chained.</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={async () => setVerify(await api.get('/api/audit/verify'))}>Verify integrity</button>
          <a className="btn" href={`/api/audit.csv?${filterQuery}`}>Export CSV</a>
        </div>
      </header>
      {verify && (
        <div className={verify.ok ? 'success' : 'error'}>
          {verify.ok ? `Hash chain intact: ${verify.checked} entries verified.` : `Hash chain broken at entry ${verify.broken_at}. The audit trail may have been tampered with.`}
        </div>
      )}
      <form className="filters audit-filters" onSubmit={apply}>
        <input placeholder="Actor" value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} />
        <select value={draft.actor_type} onChange={(e) => setDraft({ ...draft, actor_type: e.target.value })}>
          <option value="">Any actor type</option>
          {ACTOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={draft.entity_type} onChange={(e) => setDraft({ ...draft, entity_type: e.target.value })}>
          <option value="">Anything</option>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="Ref (PRB…, username)" value={draft.entity_ref} onChange={(e) => setDraft({ ...draft, entity_ref: e.target.value })} />
        <input placeholder="Action" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
        <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} aria-label="From" />
        <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} aria-label="To" />
        <input placeholder="IP" value={draft.ip} onChange={(e) => setDraft({ ...draft, ip: e.target.value })} />
        <input placeholder="Token prefix" value={draft.token_prefix} onChange={(e) => setDraft({ ...draft, token_prefix: e.target.value })} />
        {draft.actor_id && <span className="tag">User #{draft.actor_id}</span>}
        <button className="btn primary">Filter</button>
        {params.toString() && <button type="button" className="btn-link" onClick={() => { setDraft(Object.fromEntries(FILTERS.map((f) => [f, '']))); setParams({}, { replace: true }); }}>Clear</button>}
      </form>
      {error && <div className="error">{error}</div>}
      <section className="card flush">
        {entries.length === 0 ? <p className="empty">No entries match.</p> : (
          <div className="table-wrap">
            <table className="table compact audit-table">
              <thead><tr><th>When</th><th>Who</th><th>Via</th><th>What</th><th>Changes</th><th>Reason</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className={open === e.id ? 'open' : ''} onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="nowrap" title={formatDate(e.at)}>{relativeTime(e.at)}</td>
                    <td>{e.actor_name || '–'}<div className="muted small">{e.actor_type}</div></td>
                    <td className="small">{e.channel}{e.token_prefix && <div className="mono muted">{e.token_prefix}…</div>}{open === e.id && <div className="muted">{e.ip}<br />{e.user_agent}<br />req {e.request_id}</div>}</td>
                    <td>
                      <span className="tag">{e.entity_type}</span>{' '}
                      {recordPath(e.entity_ref) ? <Link to={recordPath(e.entity_ref)!} className="mono" onClick={(ev) => ev.stopPropagation()}>{e.entity_ref}</Link> : <span className="mono">{e.entity_ref}</span>}
                      <div><strong>{e.action}</strong></div>
                    </td>
                    <td className="audit-changes-cell">{open === e.id ? <ChangeList changes={e.changes} /> : <span className="muted small">{Object.keys(e.changes ?? {}).join(', ') || '–'}</span>}</td>
                    <td className="small">{e.reason || <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {more && <button className="btn" onClick={() => load(entries[entries.length - 1].id)}>Load older entries</button>}
    </>
  );
}
