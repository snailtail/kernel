import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client';
import { ImpactSection, RelationshipsSection } from './components/CmdbGraph';
import { CommentBox } from '../../components/CommentBox';
import { Markdown } from '../../components/Markdown';
import { AttachmentsPanel } from '../../components/Attachments';
import { SeverityBadge } from '../../components/Badges';
import { formatDate, relativeTime } from '../../format';
import { useLive } from '../../hooks/useLive';
import { Presence } from '../../components/Presence';
import { useApi, useRecord } from '../../hooks';
import { useSession } from '../../session';
import { HistoryPanel } from '../../components/History';
import type { CiDetail, CiType } from '../../api/types/cmdb';
import { STATUSES, CRITICALITY, canManage, CiStatus } from './common';
import { CiLinks } from './components/CiLinks';
import { CiModal } from './components/CiModal';

export function CiPage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: ci, setData, error, refresh, actionError, setActionError, run } = useRecord<CiDetail>(`/api/cis/${ref}`);
  const others = useLive([ci && `ci:${ci.id}`], refresh, { presence: true });
  const { data: types } = useApi<CiType[]>('/api/ci-types');
  const [editing, setEditing] = useState(false);
  if (error) return <div className="error">{error}</div>;
  if (!ci) return null;
  const type = types?.find((t) => t.name === ci.ci_type);
  const manage = canManage(user);
  const annotate = user.role !== 'viewer';

  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/cis">Configuration items</Link> / <span className="mono">{ci.ref}</span> <Presence people={others} /></div>
        <h1>{ci.name}</h1>
        <div className="badges">
          <CiStatus status={ci.status} />
          <span className="badge neutral">{ci.type_label}</span>
          <span className="badge neutral">{ci.environment}</span>
          <span className={`crit crit-${ci.criticality}`}>{CRITICALITY[ci.criticality]}</span>
          {ci.tags.map((t) => <span key={t} className="tag">{t}</span>)}
        </div>
        {ci.class === 'service' && <div className="ci-head-actions"><Link className="btn" to={`/services/${ci.ref}/report`}>Service report</Link></div>}
        {manage && (
          <div className="ci-head-actions">
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
            <select value={ci.status} aria-label="Status" onChange={(e) => run(() => api.post(`/api/cis/${ci.ref}/transition`, { to: e.target.value }))}>
              {STATUSES.map((s) => <option key={s} value={s}>Status: {s}</option>)}
            </select>
          </div>
        )}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      <div className="problem-grid">
        <div className="problem-main">
          {ci.description && <section className="card"><h2>Description</h2><Markdown text={ci.description} /></section>}
          <section className="card">
            <h2>Attributes</h2>
            <dl className="kv ci-attrs">
              {(type?.attributes ?? []).map((a) => (<Fragment key={a.key}><dt>{a.label}</dt><dd className="mono">{String(ci.attributes[a.key] ?? '–')}</dd></Fragment>))}
              <dt>Owner</dt><dd>{ci.owner ?? '–'}</dd>
              <dt>Team</dt><dd>{ci.team || '–'}</dd>
              {ci.business_owner_id && <><dt>Business owner</dt><dd><Link to={`/people/${ci.business_owner_id}`}>{ci.business_owner}</Link></dd></>}
              {ci.technical_contact_id && <><dt>Technical contact</dt><dd><Link to={`/people/${ci.technical_contact_id}`}>{ci.technical_contact}</Link></dd></>}
            </dl>
          </section>
          {ci.known_errors.length > 0 && (
            <section className="card known-errors-card">
              <h2>Known errors on this {ci.class === 'service' ? 'service' : 'CI'} <span className="count">{ci.known_errors.length}</span></h2>
              {ci.known_errors.map((k) => (
                <div key={k.ref} className="ke">
                  <div><Link to={`/problems/${k.ref}`} className="mono">{k.ref}</Link> <strong>{k.title}</strong>{k.workaround_effectiveness && <span className="muted small"> · workaround {k.workaround_effectiveness}</span>}</div>
                  {k.workaround ? <div className="workaround"><span className="muted small">Workaround</span><Markdown text={k.workaround} /></div> : <p className="muted small">No workaround documented.</p>}
                </div>
              ))}
            </section>
          )}
          {(ci.problems.length > 0 || ci.recent_records.length > 0) && (
            <section className="card">
              <h2>Problems &amp; recent records</h2>
              {ci.problems.length > 0 && (
                <ul className="work-list">
                  {ci.problems.map((p) => (
                    <li key={p.ref}><div><Link to={`/problems/${p.ref}`} className="mono">{p.ref}</Link> {p.title}</div><span className="work-meta"><span className="tag">P{p.priority}</span><span className="muted small">{p.status.replace('_', ' ')}</span></span></li>
                  ))}
                </ul>
              )}
              {ci.recent_records.length > 0 && (
                <ul className="work-list">
                  {ci.recent_records.map((r) => (
                    <li key={`${r.system}-${r.kind}-${r.reference}`}>
                      <div><span className="tag">{r.kind}</span> <span className="mono">{r.reference}</span> <span className="muted small">{r.system}</span> {r.summary}</div>
                      <span className="work-meta"><span className="muted small">{r.linked ? 'linked' : 'not linked'} · {relativeTime(r.occurred_at)}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {(ci.alerts.length > 0 || ci.incidents.length > 0) && (
            <section className="card">
              <h2>Alerts &amp; incidents</h2>
              {ci.maintenance_windows.map((w) => <p key={w.id} className="hint-box">Maintenance {formatDate(w.starts_at)} – {formatDate(w.ends_at)}{w.reason && `: ${w.reason}`}. Alerts are suppressed.</p>)}
              <ul className="work-list">
                {ci.incidents.map((i) => (
                  <li key={i.ref}><div><Link to={`/incidents/${i.ref}`} className="mono">{i.ref}</Link> {i.title}</div><span className="work-meta"><span className="tag">P{i.priority}</span><span className="muted small">{i.status.replace('_', ' ')}</span></span></li>
                ))}
                {ci.alerts.map((a) => (
                  <li key={`a${a.id}`}>
                    <div><SeverityBadge severity={a.status === 'closed' ? 'clear' : a.severity} /> <span className="mono small">{a.check_key}</span> <span className="muted small">{a.source} ×{a.count}{a.suppressed ? ' · suppressed' : ''}</span></div>
                    <span className="work-meta">{a.incident_ref && <Link to={`/incidents/${a.incident_ref}`} className="mono small">{a.incident_ref}</Link>}<span className="muted small">{relativeTime(a.last_seen)}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ImpactSection key={ci.ref} ciRef={ci.ref} isService={ci.class === 'service'} />
          <RelationshipsSection ciRef={ci.ref} relationships={ci.relationships} editable={manage} onChange={setData} />
          <section className="card">
            <h2>Notes &amp; history</h2>
            {annotate && (
              <CommentBox recordRef={ci.ref} placeholder="Add a note about this CI" onError={setActionError} onSubmit={(body) => run(() => api.post(`/api/cis/${ci.ref}/comments`, { body }))} />
            )}
            <ul className="activity">
              {ci.activity.map((a) => (
                <li key={a.id}>
                  <div className="activity-head">
                    <strong>{a.user_name ?? 'System'}</strong> {a.kind === 'comment' ? 'added a note' : a.body || a.kind}
                    {(a.channel === 'mcp' || a.channel === 'api') && <span className="tag channel">via {a.channel.toUpperCase()}</span>}
                    <time title={formatDate(a.created_at)}>{relativeTime(a.created_at)}</time>
                  </div>
                  {a.kind === 'comment' && <Markdown text={a.body} className="activity-body" />}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="problem-side">
          <AttachmentsPanel recordRef={ci.ref} editable={annotate} canDelete={(a) => a.uploaded_by === user.id || user.role === 'admin' || user.role === 'manager'} />
          <HistoryPanel recordRef={ci.ref} version={ci} />
          <section className="card">
            <h2>Where it lives</h2>
            {ci.sources.length === 0 ? <p className="placeholder">Added manually; no source system.</p> : (
              <ul className="sources">
                {ci.sources.map((s) => (
                  <li key={s.id}>
                    {s.source_url ? <a className="btn small" href={s.source_url} target="_blank" rel="noreferrer noopener">Open in {s.source_system} ↗</a> : <strong>{s.source_system}</strong>}
                    <div className="muted small mono">{s.source_id}</div>
                    <div className="muted small">Seen {relativeTime(s.last_seen_at)} · first {formatDate(s.first_seen_at)}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <CiLinks ci={ci} editable={annotate} onChange={setData} />
          {ci.groups.length > 0 && (
            <section className="card">
              <h2>Groups</h2>
              <ul className="plain-list">
                {ci.groups.map((g) => <li key={g.id}><Link to={`/cis/groups?open=${g.id}`}>{g.name}</Link> <span className="muted small">{g.purpose}{g.membership === 'rule' ? ' · by rule' : ''}</span></li>)}
              </ul>
            </section>
          )}
        </aside>
      </div>
      {editing && types && <CiModal types={types} ci={ci} onClose={() => setEditing(false)} onDone={(n) => { setData(n as CiDetail); setEditing(false); }} />}
    </>
  );
}
