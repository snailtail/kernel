import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client';
import { FormModal } from '../../components/Modal';
import { formatDate, relativeTime } from '../../format';
import { useLive } from '../../hooks/useLive';
import { useApi } from '../../hooks';
import type { RetireProposal, RetireResult } from '../../api/types/cmdb';

const RECORD_PATH: Record<string, string> = { incident: '/incidents', problem: '/problems', change: '/changes' };

/** CIs missing long enough to retire (#18): a person decides, one at a time or several at once. */
export function CiRetirePage() {
  const { data, loading, refresh } = useApi<RetireProposal[]>('/api/cis/retire-proposals');
  useLive(['ci:*'], refresh);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<RetireProposal[] | null>(null);
  const [results, setResults] = useState<RetireResult[] | null>(null);
  const retirable = data?.filter((p) => p.can_retire) ?? [];
  const toggle = (ref: string) => setSelected((s) => { const n = new Set(s); if (n.has(ref)) n.delete(ref); else n.add(ref); return n; });
  const done = (r: RetireResult[]) => { setResults(r); setConfirming(null); setSelected(new Set()); refresh(); };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Proposed for retirement</h1>
          <p className="muted">CIs no source has reported for longer than the source allows (14 days unless the connector says otherwise). Retire what is really gone, or fix the sync. Kernel never retires anything by itself, and a retired CI keeps its history.</p>
        </div>
        <div className="head-actions">
          <Link className="btn" to="/cis?status=missing">All missing CIs</Link>
          {retirable.length > 0 && <button className="btn primary" disabled={!selected.size} onClick={() => setConfirming(retirable.filter((p) => selected.has(p.ref)))}>Retire selected{selected.size ? ` (${selected.size})` : ''}</button>}
        </div>
      </header>
      {results && <RetireResults results={results} onClose={() => setResults(null)} />}
      <section className={`card flush ${loading ? 'is-loading' : ''}`}>
        {data?.length === 0 ? <p className="empty">Nothing to retire: every missing CI is still within its source's grace period.</p> : (
          <div className="table-wrap">
            <table className="table retire-table">
              <thead><tr>
                {retirable.length > 0 && <th className="check-col"><input type="checkbox" aria-label="Select all" checked={retirable.length > 0 && retirable.every((p) => selected.has(p.ref))} onChange={(e) => setSelected(e.target.checked ? new Set(retirable.map((p) => p.ref)) : new Set())} /></th>}
                <th>CI</th><th className="hide-sm">Sources</th><th className="hide-sm">Relationships</th><th>Still named by</th><th></th>
              </tr></thead>
              <tbody>
                {data?.map((p) => (
                  <tr key={p.ref}>
                    {retirable.length > 0 && <td className="check-col">{p.can_retire && <input type="checkbox" aria-label={`Select ${p.ref}`} checked={selected.has(p.ref)} onChange={() => toggle(p.ref)} />}</td>}
                    <td className="title-cell"><Link className="mono" to={`/cis/${p.ref}`}>{p.ref}</Link> <Link to={`/cis/${p.ref}`}>{p.name}</Link><div className="muted small">{[p.type_label, p.environment, p.owner ?? p.team].filter(Boolean).join(' · ')}</div>
                      <div className="small" title={formatDate(p.missing_since)}>Missing {relativeTime(p.missing_since)} <span className="muted">· last seen {p.last_seen_at ? relativeTime(p.last_seen_at) : 'never'}</span></div></td>
                    <td className="hide-sm small">{p.sources.length ? p.sources.map((s) => (
                      <div key={s.source_system + s.source_id}>{s.source_url ? <a href={s.source_url} target="_blank" rel="noreferrer">{s.source_system}</a> : s.source_system} <span className="muted">{s.connector ? `waits ${p.retire_after_days} days` : 'push'}</span></div>
                    )) : <span className="muted">manual</span>}</td>
                    <td className="hide-sm small">{p.relationships.length ? p.relationships.slice(0, 3).map((r) => <div key={r.type + r.direction + r.ref}>{r.direction === 'out' ? r.type.replaceAll('_', ' ') : `${r.type.replaceAll('_', ' ')} (from)`} <Link to={`/cis/${r.ref}`}>{r.name}</Link></div>) : <span className="muted">none</span>}{p.relationships.length > 3 && <div className="muted">+{p.relationships.length - 3} more</div>}</td>
                    <td className="small">{p.open_records.length ? <span className="warn-tag">{p.open_records.map((o, n) => <Fragment key={o.ref}>{n > 0 && ', '}<Link to={`${RECORD_PATH[o.kind]}/${o.ref}`} title={o.title}>{o.ref}</Link></Fragment>)}</span> : <span className="muted">none</span>}</td>
                    <td className="nowrap">{p.can_retire && <button className="btn small" onClick={() => setConfirming([p])}>Retire</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {confirming && <RetireConfirm items={confirming} onClose={() => setConfirming(null)} onDone={done} />}
    </>
  );
}

function RetireConfirm({ items, onClose, onDone }: { items: RetireProposal[]; onClose: () => void; onDone: (r: RetireResult[]) => void }) {
  const [comment, setComment] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const named = items.filter((p) => p.open_records.length);
  const submit = async () => {
    const r = await api.post<{ results: RetireResult[] }>('/api/cis/retire', { refs: items.map((p) => p.ref), comment: comment.trim() || undefined, acknowledge_open: acknowledge });
    onDone(r.results);
  };
  return (
    <FormModal title={items.length === 1 ? `Retire ${items[0].ref}?` : `Retire ${items.length} CIs?`} submitLabel="Retire" onClose={onClose} onSubmit={submit}>
      <p className="full">{items.length === 1 ? <><strong>{items[0].name}</strong> is</> : 'They are'} kept with {items.length === 1 ? 'its' : 'their'} history and can be set active again. Nothing is deleted.</p>
      {named.length > 0 && (
        <div className="full warn-box">
          <p>Open records still name {named.length === 1 ? 'this CI' : `${named.length} of them`}: {named.flatMap((p) => p.open_records.map((o) => o.ref)).join(', ')}.</p>
          <label className="check"><input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} /> Retire {named.length === 1 ? 'it' : 'them'} anyway</label>
        </div>
      )}
      <label className="full">Why <span className="muted small">(optional, shown in the history)</span><textarea rows={2} placeholder="e.g. Decommissioned in change CHG000123" value={comment} onChange={(e) => setComment(e.target.value)} /></label>
    </FormModal>
  );
}

function RetireResults({ results, onClose }: { results: RetireResult[]; onClose: () => void }) {
  const retired = results.filter((r) => r.outcome === 'retired').length;
  const other = results.filter((r) => r.outcome !== 'retired');
  return (
    <div className={`card ${other.length ? 'warn-box' : ''}`} role="status">
      <div className="section-head"><strong>{retired} retired{other.length ? `, ${other.length} not` : ''}</strong><button className="btn-icon" onClick={onClose} aria-label="Dismiss">×</button></div>
      {other.map((r) => <div key={r.ref} className="small"><span className="mono">{r.ref}</span>: {r.reason}</div>)}
    </div>
  );
}
