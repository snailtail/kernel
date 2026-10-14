// Major incidents (#108): the response header (lead, comms lead, bridge, next update), declaring, stakeholder
// updates, related incidents, the status page proposal and the timeline of key moments.
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { formatDate, relativeTime } from '../format';
import { useSession } from '../session';
import { Markdown } from './Markdown';
import { Modal } from './Modal';

export interface MajorInfo {
  declared_at: string | null; lead_id: number | null; lead: string | null; comms_id: number | null; comms: string | null; bridge: string;
  update_minutes: number | null; next_update_at: string | null; update_overdue: boolean; last_update: { body: string; created_at: string } | null;
  pir_owner_id: number | null; pir_owner: string | null; pir_due: string | null;
}
export interface RelatedRow { ref: string; title: string; status: string; priority?: number; resolve_with_parent?: boolean; is_major?: boolean }
export interface StatusProposal { services: string[]; status: string; phase: string; message: string }

/** "in 12 min" / "8 min overdue", refreshed every 15 seconds. */
function useCountdown(at: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [at]);
  if (!at) return null;
  const min = Math.round((new Date(at).getTime() - now) / 60_000);
  return min >= 0 ? `in ${min} min` : `${-min} min overdue`;
}

const since = (at: string | null) => {
  if (!at) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

/** A bridge is a meeting link or a phone number; both open in one tap. */
function Bridge({ value }: { value: string }) {
  if (!value) return <span className="muted">–</span>;
  if (/^https?:\/\//i.test(value)) return <a href={value} target="_blank" rel="noreferrer noopener">Join the bridge ↗</a>;
  return <a href={`tel:${value.replace(/[^\d+]/g, '')}`}>{value}</a>;
}

export function MajorHeader({ incidentRef, major, open, canEdit, onChange }: { incidentRef: string; major: MajorInfo; open: boolean; canEdit: boolean; onChange: (i: any) => void }) {
  const { user } = useSession();
  const countdown = useCountdown(major.next_update_at);
  const [posting, setPosting] = useState(false);
  const [editing, setEditing] = useState(false);
  const manager = user.role === 'admin' || user.role === 'problem_manager';
  return (
    <section className={`card major-head${major.update_overdue ? ' overdue' : ''}`} aria-label="Major incident">
      <dl className="major-grid">
        <div><dt>Incident lead</dt><dd>{major.lead ?? '–'}</dd></div>
        <div><dt>Communications</dt><dd>{major.comms ?? <span className="muted">the lead</span>}</dd></div>
        <div><dt>Bridge</dt><dd><Bridge value={major.bridge} /></dd></div>
        <div><dt>Running</dt><dd title={major.declared_at ? formatDate(major.declared_at) : ''}>{since(major.declared_at)}</dd></div>
        {open && (
          <div>
            <dt>Next update</dt>
            <dd>{major.update_overdue ? <span className="badge overdue">{countdown}</span> : countdown ?? '–'} <span className="muted small">every {major.update_minutes} min</span></dd>
          </div>
        )}
        {!open && major.pir_owner && <div><dt>Review</dt><dd>{major.pir_owner}{major.pir_due ? `, by ${major.pir_due.slice(0, 10)}` : ''}</dd></div>}
      </dl>
      {canEdit && (
        <div className="actions">
          {open && <button className="btn primary" onClick={() => setPosting(true)}>Post update</button>}
          {(manager || major.lead_id === user.id) && <button className="btn" onClick={() => setEditing(true)}>Team and cadence</button>}
        </div>
      )}
      {posting && <PostUpdateModal incidentRef={incidentRef} last={major.last_update} onClose={() => setPosting(false)} onDone={(i) => { onChange(i); setPosting(false); }} />}
      {editing && <MajorTeamModal incidentRef={incidentRef} major={major} onClose={() => setEditing(false)} onDone={(i) => { onChange(i); setEditing(false); }} />}
    </section>
  );
}

/** Pre-filled with the last update: most updates change a line or two. */
function PostUpdateModal({ incidentRef, last, onClose, onDone }: { incidentRef: string; last: MajorInfo['last_update']; onClose: () => void; onDone: (i: any) => void }) {
  const [body, setBody] = useState(last?.body ?? 'Affected: …\nWhat we know: …\nWhat we are doing: …\nNext update: …');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Stakeholder update" onClose={onClose}>
      <form className="form" onSubmit={async (e) => { e.preventDefault(); try { onDone(await api.post(`/api/incidents/${incidentRef}/communications`, { body })); } catch (err) { setError((err as Error).message); } }}>
        <p className="hint-box full">Plain language for people outside IT: what is affected, what you know, what you are doing and when the next update comes. {last ? `Pre-filled with the update from ${relativeTime(last.created_at)}.` : ''}</p>
        <label className="full">Update<textarea rows={6} required value={body} onChange={(e) => setBody(e.target.value)} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!body.trim()}>Post update</button></div>
      </form>
    </Modal>
  );
}

function PeopleFields({ lead, comms, setLead, setComms }: { lead: string; comms: string; setLead: (v: string) => void; setComms: (v: string) => void }) {
  const { meta } = useSession();
  const people = meta.assignees.filter((a) => a.role !== 'viewer');
  return (
    <>
      <label>Incident lead<select value={lead} onChange={(e) => setLead(e.target.value)}>{people.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
      <label>Communications lead <span className="muted small">(optional)</span><select value={comms} onChange={(e) => setComms(e.target.value)}><option value="">The lead</option>{people.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
    </>
  );
}

export function DeclareMajorModal({ incidentRef, onClose, onDone }: { incidentRef: string; onClose: () => void; onDone: (i: any) => void }) {
  const { user } = useSession();
  const [lead, setLead] = useState(String(user.id));
  const [comms, setComms] = useState('');
  const [bridge, setBridge] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onDone(await api.post(`/api/incidents/${incidentRef}/major`, { lead_id: Number(lead), comms_id: comms ? Number(comms) : null, ...(bridge.trim() ? { bridge: bridge.trim() } : {}) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Declare a major incident" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint-box full">A major incident gets a lead, a place to talk and stakeholder updates on a fixed rhythm (by priority; the lead can change it). Problem managers are told, and the timeline starts now.</p>
        <PeopleFields lead={lead} comms={comms} setLead={setLead} setComms={setComms} />
        <label className="full">Bridge <span className="muted small">(meeting link or phone number, optional)</span><input placeholder="https://teams.microsoft.com/… or +46 8 …" value={bridge} onChange={(e) => setBridge(e.target.value)} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary danger">Declare major incident</button></div>
      </form>
    </Modal>
  );
}

function MajorTeamModal({ incidentRef, major, onClose, onDone }: { incidentRef: string; major: MajorInfo; onClose: () => void; onDone: (i: any) => void }) {
  const [lead, setLead] = useState(String(major.lead_id ?? ''));
  const [comms, setComms] = useState(major.comms_id ? String(major.comms_id) : '');
  const [bridge, setBridge] = useState(major.bridge);
  const [minutes, setMinutes] = useState(major.update_minutes ?? 60);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Major incident team" onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try {
          onDone(await api.patch(`/api/incidents/${incidentRef}/major`, { ...(lead ? { lead_id: Number(lead) } : {}), comms_id: comms ? Number(comms) : null, bridge: bridge.trim(), update_minutes: Number(minutes) }));
        } catch (err) {
          setError((err as Error).message);
        }
      }}>
        <PeopleFields lead={lead} comms={comms} setLead={setLead} setComms={setComms} />
        <label className="full">Bridge<input value={bridge} onChange={(e) => setBridge(e.target.value)} /></label>
        <label>Update every (minutes)<input type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

/** Parent, children and a suggested parent: the same outage reported more than once. */
export function RelatedIncidentsPanel({ incidentRef, isMajor, parent, children, suggested, editable, onChange }: {
  incidentRef: string; isMajor: boolean; parent: RelatedRow | null; children: RelatedRow[]; suggested: RelatedRow | null; editable: boolean; onChange: (i: any) => void;
}) {
  const [child, setChild] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>, after?: () => void) => {
    setError(null);
    try { onChange(await fn()); after?.(); } catch (err) { setError((err as Error).message); }
  };
  if (!parent && !children.length && !suggested && !isMajor) return null;
  return (
    <section className="card">
      <h2>Related incidents{children.length > 0 && <span className="count">{children.length}</span>}</h2>
      {parent && <p>Part of <Link to={`/incidents/${parent.ref}`} className="mono">{parent.ref}</Link> {parent.title} <span className="muted small">{parent.status.replace('_', ' ')}</span></p>}
      {suggested && (
        <div className="hint-box">
          Same outage as <Link to={`/incidents/${suggested.ref}`} className="mono">{suggested.ref}</Link> {suggested.title}?
          {editable && <> <button className="btn small" onClick={() => act(() => api.post(`/api/incidents/${suggested.ref}/children`, { child: incidentRef }).then(() => api.get(`/api/incidents/${incidentRef}`)))}>Relate to {suggested.ref}</button></>}
        </div>
      )}
      {children.length > 0 && (
        <ul className="plain-list">
          {children.map((c) => (
            <li key={c.ref}>
              <Link to={`/incidents/${c.ref}`} className="mono">{c.ref}</Link> {c.title} <span className="muted small">{c.status.replace('_', ' ')}</span>
              {editable && (
                <div className="small">
                  <label className="check"><input type="checkbox" checked={!!c.resolve_with_parent} disabled={['resolved', 'closed'].includes(c.status)} onChange={(e) => act(() => api.post(`/api/incidents/${incidentRef}/children`, { child: c.ref, resolve_with_parent: e.target.checked }))} /> resolve with this one</label>{' '}
                  <button className="btn-link small" onClick={() => act(() => api.del(`/api/incidents/${incidentRef}/children/${c.ref}`))}>Unlink</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {isMajor && editable && (
        <div className="rel-form">
          <input placeholder="INC…" value={child} onChange={(e) => setChild(e.target.value)} aria-label="Related incident ref" />
          <button className="btn" disabled={!child.trim()} onClick={() => act(() => api.post(`/api/incidents/${incidentRef}/children`, { child: child.trim() }), () => setChild(''))}>Relate</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

/** A draft for the status board: a person reviews it, and only they can make it public. */
export function StatusProposalCard({ incidentRef, proposal, onPosted }: { incidentRef: string; proposal: StatusProposal; onPosted: () => void }) {
  const { user } = useSession();
  const [message, setMessage] = useState(proposal.message);
  const [status, setStatus] = useState(proposal.status);
  const [publish, setPublish] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPublish = user.role === 'admin' || user.role === 'problem_manager';
  return (
    <section className="card">
      <h2>Status page</h2>
      <p className="muted small">A draft for {proposal.services.join(', ')}. Nothing is posted until you do.</p>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post('/api/status/updates', { incident: incidentRef, services: proposal.services, phase: proposal.phase, status, message, public: publish });
          onPosted();
        } catch (err) {
          setError((err as Error).message);
        }
      }}>
        <label className="full">Status<select value={status} onChange={(e) => setStatus(e.target.value)}>{['degraded', 'partial_outage', 'major_outage'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></label>
        <label className="full">Message<textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
        {canPublish && <label className="check full"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Also publish on the public status page</label>}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button className="btn">{publish ? 'Post and publish' : 'Post to the status board'}</button></div>
      </form>
    </section>
  );
}

interface TimelineEntry { activity_id: number; at: string; kind: string; key_moment: boolean; by: string | null; label: string; body: string }

/** Key moments only, oldest first; the start of the post-incident review. */
export function IncidentTimeline({ incidentRef, version }: { incidentRef: string; version: unknown }) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  useEffect(() => {
    api.get<{ entries: TimelineEntry[] }>(`/api/incidents/${incidentRef}/timeline`).then((t) => setEntries(t.entries)).catch(() => setEntries([]));
  }, [incidentRef, version]);
  if (!entries) return null;
  return (
    <>
      <p className="muted small">Key moments only. Mark any note with ☆ to add it. <a href={`/api/incidents/${incidentRef}/timeline?format=md`} download>Export as Markdown</a></p>
      <ol className="timeline">
        {entries.map((e, n) => (
          <li key={`${e.activity_id}-${n}`} className={e.kind === 'communication' ? 'communication' : ''}>
            <time title={formatDate(e.at)}>{formatDate(e.at)}</time>
            <div><strong>{e.label}</strong>{e.key_moment && ' ★'} {e.by && <span className="muted small">{e.by}</span>}{e.body && <Markdown text={e.body} className="activity-body" />}</div>
          </li>
        ))}
      </ol>
    </>
  );
}

/** The star on an activity entry: mark it a key moment. */
export function KeyMomentToggle({ incidentRef, activityId, marked, onChange }: { incidentRef: string; activityId: number; marked: boolean; onChange: () => void }) {
  return (
    <button className="btn-link small key-moment" aria-pressed={marked} title={marked ? 'A key moment on the timeline' : 'Mark as a key moment'}
      onClick={async () => { await api.put(`/api/incidents/${incidentRef}/activity/${activityId}/key-moment`, { key_moment: !marked }); onChange(); }}>
      {marked ? '★' : '☆'}
    </button>
  );
}
