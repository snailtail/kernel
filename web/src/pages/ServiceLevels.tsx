import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { Modal } from '../components/Modal';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { duration } from '../format';

interface Sla { id: number; name: string; description: string; calendar_id: number; calendar: string; response_minutes: Record<string, number>; resolution_minutes: Record<string, number>; availability_target: number | null; is_default: boolean; services: number }
interface Cal { id: number; name: string; timezone: string; always: boolean; include_customary: boolean; hours: Record<string, [number, number][]>; holiday_preset: string | null; holidays: { day: string; name: string }[] }
interface Service { ref: string; name: string; status: string; criticality: number; team: string; owner: string | null; user_description: string; how_to_get_help: string; in_catalogue: boolean; sla: string | null; support_hours: string | null; response_minutes: Record<string, number> | null; resolution_minutes: Record<string, number> | null; open_incidents: number }

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function ServiceLevelsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'catalogue';
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Services &amp; service levels</h1>
          <p className="muted">What we deliver, how to get help, and the response and resolution targets incidents are measured against.</p>
        </div>
      </header>
      <div className="seg-toggle tabs" role="tablist">
        {[['catalogue', 'Service catalogue'], ['slas', 'SLAs'], ['calendars', 'Business hours']].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setParams({ tab: id }, { replace: true })}>{label}</button>
        ))}
      </div>
      {tab === 'catalogue' && <Catalogue />}
      {tab === 'slas' && <Slas />}
      {tab === 'calendars' && <Calendars />}
    </>
  );
}

function Catalogue() {
  const { data } = useApi<Service[]>('/api/service-catalogue');
  const listed = data?.filter((s) => s.in_catalogue) ?? [];
  const other = data?.filter((s) => !s.in_catalogue) ?? [];
  const card = (s: Service) => (
    <article key={s.ref} className="card service-card">
      <header>
        <h2><Link to={`/cis/${s.ref}`}>{s.name}</Link></h2>
        {s.open_incidents > 0 && <Link to={`/incidents?ci=${s.ref}`} className="badge inc-in_progress">{s.open_incidents} open incident{s.open_incidents > 1 ? 's' : ''}</Link>}
      </header>
      {s.user_description && <p>{s.user_description}</p>}
      {s.how_to_get_help && <p className="hint-box"><strong>Get help:</strong> {s.how_to_get_help}</p>}
      <dl className="kv">
        <dt>Owner / team</dt><dd>{[s.owner, s.team].filter(Boolean).join(' · ') || '–'}</dd>
        <dt>Service level</dt><dd>{s.sla ?? 'Default'}</dd>
        <dt>Support hours</dt><dd>{s.support_hours ?? '–'}</dd>
        {s.resolution_minutes && <><dt>P1 / P2 resolution</dt><dd>{duration(s.resolution_minutes['1'])} / {duration(s.resolution_minutes['2'])}</dd></>}
      </dl>
    </article>
  );
  return (
    <>
      {listed.length === 0 && <p className="empty">No services are published in the catalogue yet. Edit a service in the CMDB and tick “Show in the service catalogue”.</p>}
      <div className="group-grid">{listed.map(card)}</div>
      {other.length > 0 && (
        <details className="card">
          <summary>{other.length} internal service{other.length > 1 ? 's' : ''} not in the catalogue</summary>
          <ul className="plain-list">{other.map((s) => <li key={s.ref}><Link to={`/cis/${s.ref}`}>{s.name}</Link> <span className="muted small">{s.sla ?? 'default SLA'}</span></li>)}</ul>
        </details>
      )}
    </>
  );
}

function Slas() {
  const { user } = useSession();
  const manager = user.role === 'admin' || user.role === 'problem_manager';
  const { data, reload } = useApi<Sla[]>('/api/slas');
  const { data: cals } = useApi<Cal[]>('/api/calendars');
  const [editing, setEditing] = useState<Partial<Sla> | null>(null);
  return (
    <>
      <div className="section-head"><p className="muted">Targets are in business time of the SLA's calendar. Incidents use the SLA of their most critical service, otherwise the default.</p>{manager && <button className="btn primary" onClick={() => setEditing({ name: '', description: '', calendar_id: cals?.[0]?.id, response_minutes: {}, resolution_minutes: {}, is_default: false })}>New SLA</button>}</div>
      <section className="card flush">
        <p className="muted small pad">Each priority shows response / resolution.</p>
        <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>SLA</th><th>Hours</th>{[1, 2, 3, 4, 5].map((p) => <th key={p} className="num">P{p}</th>)}<th className="num">Services</th></tr></thead>
          <tbody>
            {data?.map((s) => (
              <tr key={s.id} onClick={() => manager && setEditing(s)} className={manager ? 'clickable' : ''}>
                <td><strong>{s.name}</strong>{s.is_default && <span className="tag">default</span>}<div className="muted small">{s.description}</div></td>
                <td className="small">{s.calendar}</td>
                {[1, 2, 3, 4, 5].map((p) => <td key={p} className="num small">{duration(s.response_minutes[p])} / {duration(s.resolution_minutes[p])}</td>)}
                <td className="num">{s.services}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>
      {editing && cals && <SlaEditor sla={editing} calendars={cals} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function SlaEditor({ sla, calendars, onClose, onDone }: { sla: Partial<Sla>; calendars: Cal[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ ...sla });
  const [error, setError] = useState<string | null>(null);
  const setTarget = (kind: 'response_minutes' | 'resolution_minutes', p: number, v: string) => {
    const next = { ...(form[kind] ?? {}) };
    if (v) next[p] = Number(v);
    else delete next[p];
    setForm({ ...form, [kind]: next });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name: form.name, description: form.description ?? '', calendar_id: Number(form.calendar_id), response_minutes: form.response_minutes, resolution_minutes: form.resolution_minutes, availability_target: form.availability_target ?? null, is_default: !!form.is_default };
    try {
      if (sla.id) await api.put(`/api/slas/${sla.id}`, body);
      else await api.post('/api/slas', body);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={sla.id ? `Edit ${sla.name}` : 'New SLA'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Name<input required value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Business hours<select value={form.calendar_id} onChange={(e) => setForm({ ...form, calendar_id: Number(e.target.value) })}>{calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="full">Description<input value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <table className="table compact full targets">
          <thead><tr><th>Priority</th><th>Response (minutes)</th><th>Resolution (minutes)</th></tr></thead>
          <tbody>
            {[1, 2, 3, 4, 5].map((p) => (
              <tr key={p}>
                <td>P{p}</td>
                <td><input type="number" min={1} value={form.response_minutes?.[p] ?? ''} onChange={(e) => setTarget('response_minutes', p, e.target.value)} aria-label={`P${p} response`} /></td>
                <td><input type="number" min={1} value={form.resolution_minutes?.[p] ?? ''} onChange={(e) => setTarget('resolution_minutes', p, e.target.value)} aria-label={`P${p} resolution`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <label>Availability target (%)<input type="number" step="0.001" min={0} max={100} value={form.availability_target ?? ''} onChange={(e) => setForm({ ...form, availability_target: e.target.value ? Number(e.target.value) : null })} /></label>
        <label className="check"><input type="checkbox" checked={!!form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} /> Default SLA</label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

function Calendars() {
  const { user } = useSession();
  const manager = user.role === 'admin' || user.role === 'problem_manager';
  const { data, reload } = useApi<Cal[]>('/api/calendars');
  const [editing, setEditing] = useState<Partial<Cal> | null>(null);
  return (
    <>
      <div className="section-head"><p className="muted">Open hours are evaluated in the calendar's time zone, so daylight saving changes are handled.</p>{manager && <button className="btn primary" onClick={() => setEditing({ name: '', timezone: 'Europe/Stockholm', always: false, hours: { 1: [[480, 1020]], 2: [[480, 1020]], 3: [[480, 1020]], 4: [[480, 1020]], 5: [[480, 1020]] }, holiday_preset: 'SE', holidays: [] })}>New calendar</button>}</div>
      <div className="group-grid">
        {data?.map((c) => (
          <button key={c.id} className="card group-card" disabled={!manager} onClick={() => setEditing(c)}>
            <strong>{c.name}</strong>
            <span className="muted small">{c.timezone}{c.holiday_preset === 'SE' && ` · Swedish public holidays${c.include_customary ? ' and customary days off' : ''}`}{c.holidays.length > 0 && ` · ${c.holidays.length} extra closed days`}</span>
            <span className="small">{c.always ? 'Around the clock' : DAYS.map((d, n) => (c.hours[n + 1]?.length ? `${d} ${c.hours[n + 1].map(([s, e]) => `${hm(s)}–${hm(e)}`).join(', ')}` : null)).filter(Boolean).join(' · ') || 'Always closed'}</span>
          </button>
        ))}
      </div>
      {editing && <CalendarEditor cal={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function CalendarEditor({ cal, onClose, onDone }: { cal: Partial<Cal>; onClose: () => void; onDone: () => void }) {
  const toText = (v: [number, number][] | undefined) => (v ?? []).map(([s, e]) => `${hm(s)}-${hm(e)}`).join(', ');
  const [form, setForm] = useState({
    name: cal.name ?? '', timezone: cal.timezone ?? 'Europe/Stockholm', always: !!cal.always, holiday_preset: cal.holiday_preset ?? '', include_customary: cal.include_customary ?? true,
    hours: Object.fromEntries(DAYS.map((_, n) => [n + 1, toText(cal.hours?.[n + 1])])) as Record<number, string>,
    holidays: (cal.holidays ?? []).map((h) => `${h.day} ${h.name}`).join('\n'),
  });
  const [error, setError] = useState<string | null>(null);
  const parse = (text: string): [number, number][] =>
    text.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const m = p.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      if (!m) throw new Error(`Write hours as 08:00-17:00 (got "${p}")`);
      return [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]];
    });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = {
        name: form.name, timezone: form.timezone, always: form.always, holiday_preset: form.holiday_preset || null, include_customary: form.include_customary,
        hours: Object.fromEntries(Object.entries(form.hours).map(([d, t]) => [d, parse(t)]).filter(([, v]) => (v as unknown[]).length)),
        holidays: form.holidays.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ day: l.slice(0, 10), name: l.slice(11).trim() })),
      };
      if (cal.id) await api.put(`/api/calendars/${cal.id}`, body);
      else await api.post('/api/calendars', body);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={cal.id ? `Edit ${cal.name}` : 'New calendar'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Time zone<input required value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></label>
        <label className="check full"><input type="checkbox" checked={form.always} onChange={(e) => setForm({ ...form, always: e.target.checked })} /> Open around the clock (24/7)</label>
        {!form.always && (
          <>
            {DAYS.map((d, n) => <label key={d}>{d}<input placeholder="closed" value={form.hours[n + 1]} onChange={(e) => setForm({ ...form, hours: { ...form.hours, [n + 1]: e.target.value } })} /></label>)}
            <label>Public holidays<select value={form.holiday_preset} onChange={(e) => setForm({ ...form, holiday_preset: e.target.value })}><option value="">None</option><option value="SE">Sweden</option></select></label>
            {form.holiday_preset === 'SE' && <label className="check"><input type="checkbox" checked={form.include_customary} onChange={(e) => setForm({ ...form, include_customary: e.target.checked })} /> Also closed on customary days off (Julafton, Nyårsafton, Midsommarafton – not public holidays)</label>}
            <label className="full">Extra closed days <span className="muted small">(one per line: 2026-12-23 Inventory)</span><textarea rows={3} value={form.holidays} onChange={(e) => setForm({ ...form, holidays: e.target.value })} /></label>
          </>
        )}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}
