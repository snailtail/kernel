// On-call (#111): who is on call for a team, the team's paging target and rotation, and an incident's pages.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDate, relativeTime } from '../format';
import { useSession } from '../session';
import { FormModal } from './Modal';
import type { OnCallNow, PagingTarget, Team, TeamPaging, OnCallPage } from '../api/types/teams';

let cache: { at: number; list: OnCallNow[] } | null = null;

/** Who is on call per team; the server caches a minute too. */
function useOnCall() {
  const [list, setList] = useState<OnCallNow[]>(cache?.list ?? []);
  useEffect(() => {
    if (cache && Date.now() - cache.at < 60_000) return;
    api.get<OnCallNow[]>('/api/on-call').then((l) => { cache = { at: Date.now(), list: l }; setList(l); }, () => {});
  }, []);
  return list;
}
const forgetOnCall = () => { cache = null; };

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** "On call now: Nora (until Mon 08:00)", or why it is not known. Nothing for a team without paging. */
export function OnCallLine({ teamId }: { teamId: number | null | undefined }) {
  const list = useOnCall();
  const c = list.find((x) => x.team_id === teamId);
  if (!c || c.source === 'none') return null;
  if (c.unavailable) return <div className="muted small on-call">On call: {c.unavailable}</div>;
  if (!c.people.length) return <div className="muted small on-call">On call: nobody in the {c.source}</div>;
  return (
    <div className="small on-call">
      <span className="muted">On call now:</span> {c.people.map((p, n) => <span key={n}>{n > 0 && ', '}<strong>{p.name}</strong>{p.until && <span className="muted"> (until {time(p.until)})</span>}</span>)}
      <span className="muted"> · {c.source}</span>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { pagerduty: 'PagerDuty', opsgenie: 'Opsgenie', grafana_oncall: 'Grafana OnCall', webhook: 'Signed webhook', rotation: 'Built-in rotation' };
const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** On the team page: who is on call, how the team is paged, and the rotation. */
export function PagingCard({ team }: { team: Team }) {
  const { user } = useSession();
  const [p, setP] = useState<TeamPaging | null>(null);
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [token, setToken] = useState<{ url: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.get<TeamPaging>(`/api/teams/${team.id}/paging`).then(setP, () => {});
  useEffect(() => { load(); }, [team.id]);
  const admin = user.role === 'admin';
  const lead = team.members.some((m) => m.user_id === user.id && m.role === 'lead');
  const member = team.members.some((m) => m.user_id === user.id);
  if (!p) return null;
  const t = p.target;
  const takeShift = async () => {
    const hours = Number(window.prompt('Take the shift from now, for how many hours?', '12'));
    if (!hours) return;
    setError(null);
    try {
      setP(await api.post(`/api/teams/${team.id}/rotation/overrides`, { user_id: user.id, starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + hours * 3600_000).toISOString(), reason: 'Took the shift' }));
      forgetOnCall();
    } catch (err) { setError((err as Error).message); }
  };
  return (
    <section className="card">
      <div className="section-head">
        <h2>On call</h2>
        <span className="section-actions">
          {admin && <button className="btn-link" onClick={() => setEditing(true)}>{t ? 'Paging' : 'Set up paging'}</button>}
          {(admin || lead) && (!t || t.kind === 'rotation') && <button className="btn-link" onClick={() => setRotating(true)}>Rotation</button>}
        </span>
      </div>
      <OnCallLine teamId={team.id} />
      {t ? (
        <p className="muted small">
          {KIND_LABEL[t.kind]}{!t.enabled && ' (off)'} pages for {t.rule.priorities.map((n) => `P${n}`).join(', ') || 'no priority'}{t.rule.major ? ' and major incidents' : ''}
          {t.rule.services.length ? ` on ${t.rule.services.join(', ')}` : ''}{t.rule.hours !== 'always' ? (t.rule.hours === 'business' ? ', in business hours' : ', out of hours') : ''}.
        </p>
      ) : <p className="muted small">Not paged. High-priority incidents wait in the queue until someone looks.</p>}
      {t?.kind === 'rotation' && <p className="muted small">The built-in rotation notifies in Kernel. It does not escalate or phone anyone: a team that needs that uses a paging tool.</p>}
      {p.overrides.length > 0 && (
        <ul className="plain-list small">{p.overrides.map((o) => <li key={o.id}>{o.name}: {formatDate(o.starts_at)} – {formatDate(o.ends_at)}{o.reason && <span className="muted"> · {o.reason}</span>}</li>)}</ul>
      )}
      {member && (!t || t.kind === 'rotation') && p.rotation && <button className="btn small" onClick={takeShift}>Take the shift</button>}
      {token && <div className="hint-box">Inbound webhook for acknowledgements: <span className="mono">{token.url}</span> with <span className="mono">Authorization: Bearer {token.token}</span>. Shown once.</div>}
      {error && <div className="error">{error}</div>}
      {editing && <PagingModal team={team} target={t} onClose={() => setEditing(false)} onDone={(r) => { setEditing(false); forgetOnCall(); load(); if (r?.inbound_token) setToken({ url: r.inbound_url, token: r.inbound_token }); }} />}
      {rotating && <RotationModal team={team} paging={p} onClose={() => setRotating(false)} onDone={(n) => { setRotating(false); forgetOnCall(); setP(n); }} />}
    </section>
  );
}

function PagingModal({ team, target, onClose, onDone }: { team: Team; target: PagingTarget | null; onClose: () => void; onDone: (r: any) => void }) {
  const [kind, setKind] = useState(target?.kind ?? 'pagerduty');
  const [cfg, setCfg] = useState<Record<string, any>>(target?.config ?? {});
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [priorities, setPriorities] = useState<number[]>(target?.rule.priorities ?? [1, 2]);
  const [major, setMajor] = useState(target?.rule.major ?? true);
  const [hours, setHours] = useState(target?.rule.hours ?? 'always');
  const [services, setServices] = useState((target?.rule.services ?? []).join(', '));
  const [allow, setAllow] = useState((target?.private_allow ?? []).join(', '));
  const [enabled, setEnabled] = useState(target?.enabled ?? true);
  const keep = target?.has_secret && target.kind === kind ? 'unchanged' : '';
  const field = (k: string, label: string, hint = '', placeholder = '') => (
    <label className="full">{label} {hint && <span className="muted small">({hint})</span>}<input value={cfg[k] ?? ''} placeholder={placeholder} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} /></label>
  );
  const secretField = (k: string, label: string) => (
    <label className="full">{label}<input type="password" autoComplete="new-password" placeholder={keep} value={secret[k] ?? ''} onChange={(e) => setSecret({ ...secret, [k]: e.target.value })} /></label>
  );
  const submit = async () => {
    const filled = Object.fromEntries(Object.entries(secret).filter(([, v]) => v.trim()));
    onDone(await api.put(`/api/teams/${team.id}/paging`, {
      kind, config: Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== '' && v !== undefined)), ...(Object.keys(filled).length ? { secret: filled } : {}),
      rule: { priorities, major, hours, services: services.split(/[\s,]+/).filter(Boolean) }, private_allow: allow.split(/[\s,]+/).filter(Boolean), enabled, new_inbound_token: !target,
    }));
  };
  return (
    <FormModal title={`Paging for ${team.name}`} submitLabel="Save" onClose={onClose} onSubmit={submit}
      actions={target && <button type="button" className="btn danger" onClick={async () => { await api.del(`/api/teams/${team.id}/paging`); onDone(null); }}>Remove</button>}>
      <p className="hint-box full">Kernel pages the team through your paging tool: it triggers on a matching incident, acknowledges when someone responds in Kernel and resolves with the incident (the incident ref is the dedup key). Escalation, phone calls and schedules stay in the tool.</p>
      <label className="full">Tool<select value={kind} onChange={(e) => { setKind(e.target.value); setSecret({}); }}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      {kind === 'pagerduty' && <>{secretField('routing_key', 'Integration (routing) key')}{field('escalation_policy_id', 'Escalation policy ID', 'for "who is on call"', 'P1234AB')}{secretField('api_token', 'REST API token (read-only, for who is on call)')}</>}
      {kind === 'opsgenie' && <>{secretField('api_key', 'API key (Alerts)')}<label>Region<select value={cfg.region ?? 'us'} onChange={(e) => setCfg({ ...cfg, region: e.target.value })}><option value="us">US</option><option value="eu">EU</option></select></label>{field('schedule_id', 'Schedule ID', 'for "who is on call"')}</>}
      {kind === 'grafana_oncall' && secretField('url', 'Integration URL (formatted webhook)')}
      {kind === 'webhook' && <>{field('url', 'URL', 'SMS gateway, ntfy… https only', 'https://')}{secretField('signing_secret', 'Signing secret (Standard Webhooks)')}</>}
      {kind === 'rotation' && <p className="muted small full">Set the members and the handover under Rotation. The person on call gets a notification in Kernel (and by email or chat as they chose).</p>}
      <fieldset className="full"><legend>Page for</legend>
        {[1, 2, 3, 4, 5].map((n) => <label key={n} className="check"><input type="checkbox" checked={priorities.includes(n)} onChange={(e) => setPriorities(e.target.checked ? [...priorities, n].sort() : priorities.filter((x) => x !== n))} /> P{n}</label>)}
        <label className="check"><input type="checkbox" checked={major} onChange={(e) => setMajor(e.target.checked)} /> Major incidents</label>
      </fieldset>
      <label>When<select value={hours} onChange={(e) => setHours(e.target.value)}><option value="always">Always</option><option value="business">In business hours</option><option value="out_of_hours">Out of hours</option></select></label>
      <label>Only these services <span className="muted small">(refs, optional)</span><input value={services} onChange={(e) => setServices(e.target.value)} placeholder="SVC000001" /></label>
      <label className="full">Private network access <span className="muted small">(for a self-hosted tool on your LAN)</span><input value={allow} onChange={(e) => setAllow(e.target.value)} /></label>
      <label className="check full"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
    </FormModal>
  );
}

function RotationModal({ team, paging, onClose, onDone }: { team: Team; paging: TeamPaging; onClose: () => void; onDone: (p: TeamPaging) => void }) {
  const [order, setOrder] = useState<number[]>(paging.rotation?.members ?? team.members.map((m) => m.user_id));
  const [dow, setDow] = useState(paging.rotation?.handover_dow ?? 1);
  const [at, setAt] = useState(() => { const m = paging.rotation?.handover_minute ?? 540; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; });
  const name = (id: number) => team.members.find((m) => m.user_id === id)?.name ?? `#${id}`;
  const move = (i: number, d: number) => { const n = [...order]; [n[i], n[i + d]] = [n[i + d], n[i]]; setOrder(n); };
  return (
    <FormModal title={`Rotation for ${team.name}`} submitLabel="Save" onClose={onClose} onSubmit={async () => {
      const [h, m] = at.split(':').map(Number);
      onDone(await api.put(`/api/teams/${team.id}/rotation`, { members: order, handover_dow: dow, handover_minute: h * 60 + m, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    }}>
      <p className="muted small full">One person a week, in this order. Anyone in the team can take a shift for a while (an override).</p>
      <ol className="full rotation-order">
        {order.map((id, i) => (
          <li key={id}>{name(id)}
            <span className="actions">
              <button type="button" className="btn-link small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Earlier">↑</button>
              <button type="button" className="btn-link small" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label="Later">↓</button>
              <button type="button" className="btn-link small" onClick={() => setOrder(order.filter((x) => x !== id))}>Remove</button>
            </span>
          </li>
        ))}
      </ol>
      {team.members.some((m) => !order.includes(m.user_id)) && (
        <label className="full">Add<select value="" onChange={(e) => e.target.value && setOrder([...order, Number(e.target.value)])}><option value="">…</option>{team.members.filter((m) => !order.includes(m.user_id)).map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</select></label>
      )}
      <label>Handover<select value={dow} onChange={(e) => setDow(Number(e.target.value))}>{DAYS.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></label>
      <label>At<input type="time" value={at} onChange={(e) => setAt(e.target.value)} /></label>
    </FormModal>
  );
}

/** On the incident: who is on call for its team, and every page that went out (or failed). */
export function PagesCard({ teamId, pages }: { teamId: number | null; pages: OnCallPage[] }) {
  if (!teamId && !pages.length) return null;
  return (
    <section className="card">
      <h2>Paging</h2>
      <OnCallLine teamId={teamId} />
      {pages.length > 0 ? (
        <ul className="plain-list small">
          {pages.map((p) => (
            <li key={p.id}>
              <span className={`badge page-${p.status}`}>{p.status}</span> {p.action} via {KIND_LABEL[p.kind] ?? p.kind}{p.team ? ` · ${p.team}` : ''}{p.paged_user ? ` → ${p.paged_user}` : ''}
              <span className="muted"> {relativeTime(p.sent_at ?? p.created_at)}{p.error ? ` · ${p.error}${p.status === 'queued' ? ` (attempt ${p.attempts})` : ''}` : ''}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">Nothing paged.</p>}
    </section>
  );
}
