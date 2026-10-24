import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { askReason } from '../components/Ask';
import { SeverityBadge } from '../components/Badges';
import { FormModal, Modal } from '../components/Modal';
import { formatDate, relativeTime } from '../format';
import { useApi, useListParams, useSearchText } from '../hooks';
import { useListToolkit } from '../components/list/ListToolkit';
import { useColumns, type ColumnKey } from '../components/list/columns';
import { SavedViews } from '../components/SavedViews';
import { useSession } from '../session';
import type { Alert, EventRule, EventSource, MaintenanceWindow } from '../api/types/events';

const SEVERITIES = ['info', 'warning', 'minor', 'major', 'critical'] as const;

const TABS = [['alerts', 'Alerts'], ['rules', 'Rules'], ['maintenance', 'Maintenance'], ['sources', 'Sources']] as const;

export function EventsPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'alerts';
  const tabs = TABS.filter(([id]) => id !== 'sources' || user.role === 'admin');
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Events</h1>
          <p className="muted">Alerts from monitoring, deduplicated per CI and check. Rules turn them into incidents; maintenance suppresses them.</p>
        </div>
        {tab === 'alerts' && <SavedViews list="alerts" />}
      </header>
      <div className="seg-toggle tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setParams({ tab: id }, { replace: true })}>{label}</button>
        ))}
      </div>
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'maintenance' && <MaintenanceTab />}
      {tab === 'sources' && user.role === 'admin' && <SourcesTab />}
    </>
  );
}

const ALERT_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'host', label: 'CI / host' }, { key: 'source', label: 'Source' }, { key: 'count', label: 'Count' }, { key: 'seen', label: 'Last seen' }, { key: 'incident', label: 'Incident' },
];

function AlertsTab() {
  const { user } = useSession();
  // The filters live in the address, so alerts can be shared and saved as views (#110).
  const { params, set } = useListParams();
  const [q, setQ] = useSearchText();
  const query = new URLSearchParams([...params].filter(([k]) => k !== 'tab'));
  const { data, reload, loading } = useApi<Alert[]>(`/api/alerts?${query}`);
  const tk = useListToolkit({ list: 'alerts', rows: data, idOf: (a) => String(a.id), filter: query.toString(), onChanged: reload });
  const cols = useColumns('alerts', ALERT_COLUMNS);
  const ack = async (id: number) => {
    await api.post(`/api/alerts/${id}/ack`, {});
    reload();
  };
  return (
    <>
      <div className="filters">
        <input className="search" placeholder="Check, host or CI…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('status') ?? 'open'} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All</option></select>
        <select value={params.get('min_severity') ?? ''} onChange={(e) => set('min_severity', e.target.value)}>
          <option value="">Any severity</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s} and above</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={params.get('suppressed') === 'true'} onChange={(e) => set('suppressed', e.target.checked ? 'true' : '')} /> Suppressed</label>
        {cols.picker}
      </div>
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {data?.length === 0 ? <p className="empty">No alerts. Configure an event source under Sources to receive them.</p> : (
          <div className="table-wrap">
            <table className="table compact">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Severity</th><th>Check</th><th data-col="host">CI / host</th><th className="hide-sm" data-col="source">Source</th><th className="num" data-col="count">Count</th><th className="hide-sm" data-col="seen">Last seen</th><th data-col="incident">Incident</th><th /></tr></thead>
              <tbody>
                {data?.map((a, n) => {
                  const row = tk.rowProps(a, n);
                  return (
                  <tr key={a.id} {...row} className={[row.className, a.status === 'closed' ? 'muted-row' : ''].filter(Boolean).join(' ') || undefined}>
                    {tk.selectAll && <td className="check-col">{tk.select(a, n)}</td>}
                    <td><SeverityBadge severity={a.status === 'closed' ? 'clear' : a.severity} /></td>
                    <td>
                      {/* Monitoring text is shown as plain text only. */}
                      <div className="mono small">{a.check_key}</div>
                      {a.message && <div className="muted small clamp">{a.message}</div>}
                      {a.flapping && <span className="tag warn-tag">flapping ×{a.flap_count}</span>}
                      {a.suppressed && <span className="tag" title={a.suppressed}>suppressed</span>}
                    </td>
                    <td data-col="host">{a.ci_ref ? <Link to={`/cis/${a.ci_ref}`}>{a.ci_name}</Link> : <span className="muted">{a.ci_hint || '–'}</span>}</td>
                    <td className="hide-sm small" data-col="source">{a.source_url ? <a href={a.source_url} target="_blank" rel="noreferrer noopener">{a.source} ↗</a> : a.source}</td>
                    <td className="num" data-col="count">{a.count}</td>
                    <td className="hide-sm muted nowrap" data-col="seen" title={formatDate(a.last_seen)}>{relativeTime(a.last_seen)}</td>
                    <td className="mono small" data-col="incident">{a.incident_ref ? <Link to={`/incidents/${a.incident_ref}`}>{a.incident_ref}</Link> : '–'}</td>
                    <td className="nowrap">
                      {a.acknowledged_by ? <span className="muted small" title={`Acknowledged by ${a.acknowledged_by}`}>✓ {a.acknowledged_by.split(' ')[0]}</span>
                        : a.status === 'open' && user.role !== 'viewer' && <button className="btn small" onClick={() => ack(a.id)}>Ack</button>}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {tk.bar}
    </>
  );
}

const emptyRule = (): Omit<EventRule, 'id'> => ({
  name: '', enabled: true, position: 100, impact: 2, urgency: 2, assignment_group: '', group_by: 'service', group_window_minutes: 60,
  max_incidents_per_hour: 5, auto_resolve: true, hold_down_minutes: 15, conditions: { min_severity: 'major' },
});

function RulesTab() {
  const { user } = useSession();
  const manager = user.role === 'admin' || user.role === 'manager';
  const { data, reload } = useApi<EventRule[]>('/api/event-rules');
  const [editing, setEditing] = useState<EventRule | Omit<EventRule, 'id'> | null>(null);
  const describe = (r: EventRule) => {
    const c = r.conditions;
    return [
      c.min_severity && `${c.min_severity} or worse`,
      c.sources?.length && `from ${c.sources.join(', ')}`,
      c.check_contains && `check contains "${c.check_contains}"`,
      c.environments?.length && `in ${c.environments.join('/')}`,
      c.max_ci_criticality && `CI criticality ≤ ${c.max_ci_criticality}`,
      c.min_count && `repeated ${c.min_count}×`,
    ].filter(Boolean).join(', ') || 'every alert';
  };
  return (
    <>
      <div className="section-head"><p className="muted">The first matching rule (lowest position) opens or groups an incident. Alerts behind one service become one incident.</p>{manager && <button className="btn primary" onClick={() => setEditing(emptyRule())}>New rule</button>}</div>
      {data?.length === 0 && <p className="empty">No rules: alerts are collected but never open incidents.</p>}
      <div className="rule-list">
        {data?.map((r) => (
          <button key={r.id} className={`card rule-card ${r.enabled ? '' : 'disabled'}`} onClick={() => manager && setEditing(r)} disabled={!manager}>
            <strong>{r.name}</strong> {!r.enabled && <span className="tag">disabled</span>}
            <div className="small">When {describe(r)} → P{r.impact + r.urgency - 1} incident{r.assignment_group && ` for ${r.assignment_group}`}</div>
            <div className="muted small">Grouped by {r.group_by} · max {r.max_incidents_per_hour}/hour · {r.auto_resolve ? `auto-resolves after ${r.hold_down_minutes} min clear` : 'resolved by people'}</div>
          </button>
        ))}
      </div>
      {editing && <RuleEditor rule={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function RuleEditor({ rule, onClose, onDone }: { rule: EventRule | Omit<EventRule, 'id'>; onClose: () => void; onDone: () => void }) {
  const [r, setR] = useState({ ...rule, sources: (rule.conditions.sources ?? []).join(', '), environments: (rule.conditions.environments ?? []).join(', ') });
  const c = r.conditions;
  const setC = (patch: Partial<EventRule['conditions']>) => setR({ ...r, conditions: { ...c, ...patch } });
  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const submit = async () => {
    const { id: _, sources, environments, ...rest } = r as EventRule & { sources: string; environments: string };
    const body = { ...rest, conditions: { ...c, sources: list(sources), environments: list(environments) } };
    if ('id' in rule) await api.put(`/api/event-rules/${rule.id}`, body);
    else await api.post('/api/event-rules', body);
    onDone();
  };
  return (
    <FormModal title={'id' in rule ? `Edit ${rule.name}` : 'New event rule'} submitLabel="Save" onClose={onClose} onSubmit={submit}
      actions={'id' in rule && <button type="button" className="btn danger" onClick={async () => { await api.del(`/api/event-rules/${rule.id}`); onDone(); }}>Delete</button>}>
      <label className="full">Name<input required value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></label>
      <fieldset className="full rules">
        <legend>When</legend>
        <label>Severity at least<select value={c.min_severity ?? ''} onChange={(e) => setC({ min_severity: e.target.value || undefined })}><option value="">any</option>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Sources<input placeholder="all" value={r.sources} onChange={(e) => setR({ ...r, sources: e.target.value })} /></label>
        <label>Check contains<input value={c.check_contains ?? ''} onChange={(e) => setC({ check_contains: e.target.value || undefined })} /></label>
        <label>Environments<input placeholder="prod, test" value={r.environments} onChange={(e) => setR({ ...r, environments: e.target.value })} /></label>
        <label>CI criticality at least<select value={c.max_ci_criticality ?? ''} onChange={(e) => setC({ max_ci_criticality: e.target.value ? Number(e.target.value) : undefined })}><option value="">any</option><option value="1">1 – business critical</option><option value="2">2 – high</option><option value="3">3 – medium</option></select></label>
        <label>Repeated at least<input type="number" min={1} value={c.min_count ?? ''} onChange={(e) => setC({ min_count: e.target.value ? Number(e.target.value) : undefined })} /></label>
        <label className="check full"><input type="checkbox" checked={c.include_unmatched !== false} onChange={(e) => setC({ include_unmatched: e.target.checked })} /> Also alerts on hosts not in the CMDB</label>
      </fieldset>
      <label>Impact<select value={r.impact} onChange={(e) => setR({ ...r, impact: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      <label>Urgency<select value={r.urgency} onChange={(e) => setR({ ...r, urgency: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      <label>Assignment group<input value={r.assignment_group} onChange={(e) => setR({ ...r, assignment_group: e.target.value })} /></label>
      <label>Group alerts by<select value={r.group_by} onChange={(e) => setR({ ...r, group_by: e.target.value as 'service' })}><option value="service">Service (via the CMDB)</option><option value="ci">CI</option><option value="rule">Rule (one incident)</option></select></label>
      <label>Max new incidents per hour<input type="number" min={1} max={100} value={r.max_incidents_per_hour} onChange={(e) => setR({ ...r, max_incidents_per_hour: Number(e.target.value) })} /></label>
      <label>Reopen within (min)<input type="number" min={1} max={1440} value={r.group_window_minutes} onChange={(e) => setR({ ...r, group_window_minutes: Number(e.target.value) })} /></label>
      <label className="check"><input type="checkbox" checked={r.auto_resolve} onChange={(e) => setR({ ...r, auto_resolve: e.target.checked })} /> Auto-resolve when all alerts clear</label>
      <label>…after staying clear (min)<input type="number" min={0} max={1440} value={r.hold_down_minutes} onChange={(e) => setR({ ...r, hold_down_minutes: Number(e.target.value) })} /></label>
      <label>Position<input type="number" min={0} value={r.position} onChange={(e) => setR({ ...r, position: Number(e.target.value) })} /></label>
      <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> Enabled</label>
    </FormModal>
  );
}

function MaintenanceTab() {
  const { user } = useSession();
  const manager = user.role === 'admin' || user.role === 'manager';
  const { data, reload } = useApi<MaintenanceWindow[]>('/api/maintenance-windows');
  const { data: groups } = useApi<{ id: number; name: string }[]>('/api/ci-groups');
  const hour = (h: number) => new Date(Date.now() + h * 3600_000).toISOString().slice(0, 16);
  const [form, setForm] = useState({ target: 'ci', ci: '', group_id: '', include_dependencies: true, starts_at: hour(0), ends_at: hour(2), reason: '' });
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/api/maintenance-windows', {
        ...(form.target === 'ci' ? { ci: form.ci, include_dependencies: form.include_dependencies } : { group_id: Number(form.group_id) }),
        starts_at: new Date(form.starts_at).toISOString(), ends_at: new Date(form.ends_at).toISOString(), reason: form.reason,
      });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="grid-2 wide-left">
      <section className="card">
        <h2>Current and upcoming</h2>
        {data?.length === 0 && <p className="placeholder">No maintenance windows.</p>}
        <ul className="work-list">
          {data?.map((w) => (
            <li key={w.id}>
              <div>
                <strong>{w.ci ? <Link to={`/cis/${w.ci}`}>{w.ci_name}</Link> : `Group ${w.group_name}`}</strong>
                {w.include_dependencies && <span className="muted small"> and its dependencies</span>} <span className="tag">{w.covered_cis} CIs</span>
                <div className="muted small">{formatDate(w.starts_at)} – {formatDate(w.ends_at)}{w.reason && ` · ${w.reason}`}</div>
              </div>
              {manager && <button className="btn-icon small" aria-label="Remove window" onClick={async () => { await api.del(`/api/maintenance-windows/${w.id}`); reload(); }}>×</button>}
            </li>
          ))}
        </ul>
      </section>
      {manager && (
        <section className="card">
          <h2>Schedule maintenance</h2>
          <form className="form" onSubmit={add}>
            <label className="full">Covers<select value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}><option value="ci">A CI or service</option><option value="group">A CI group</option></select></label>
            {form.target === 'ci' ? (
              <>
                <label className="full">CI or service ref<input required placeholder="SVC000003" value={form.ci} onChange={(e) => setForm({ ...form, ci: e.target.value })} /></label>
                <label className="check full"><input type="checkbox" checked={form.include_dependencies} onChange={(e) => setForm({ ...form, include_dependencies: e.target.checked })} /> Include everything it depends on</label>
              </>
            ) : (
              <label className="full">Group<select required value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })}><option value="">–</option>{groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
            )}
            <label>From<input type="datetime-local" required value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} /></label>
            <label>To<input type="datetime-local" required value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} /></label>
            <label className="full">Reason<input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
            {error && <div className="error full">{error}</div>}
            <div className="actions full"><button className="btn primary">Schedule</button></div>
          </form>
        </section>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { generic: 'Generic (Kernel format)', alertmanager: 'Prometheus Alertmanager', uptime_kuma: 'Uptime Kuma', azure_monitor: 'Azure Monitor (common alert schema)', op5: 'OP5 / Naemon' };

function SourcesTab() {
  const { data, reload } = useApi<EventSource[]>('/api/event-sources');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ url: string; token: string; signing_secret: string | null } | null>(null);
  const [form, setForm] = useState({ name: '', kind: 'alertmanager', ci_source_system: '', signed: false });
  const full = (path: string) => `${location.origin}${path}`;
  return (
    <>
      <div className="section-head"><p className="muted">Each monitoring tool posts to its own URL with its own token. Tokens are shown once.</p><button className="btn primary" onClick={() => setCreating(true)}>Add source</button></div>
      <section className="card flush">
        {data?.length === 0 ? <p className="empty">No sources yet.</p> : (
          <table className="table compact">
            <thead><tr><th>Name</th><th>Kind</th><th>Token</th><th className="num">Received</th><th className="num">Rejected</th><th>Last received</th><th /></tr></thead>
            <tbody>
              {data?.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong>{!s.enabled && <span className="tag">disabled</span>}<div className="mono small muted">{full(s.url)}</div></td>
                  <td className="small">{KIND_LABEL[s.kind]}{s.signed && ' · signed'}{s.ci_source_system && <div className="muted">CMDB ids: {s.ci_source_system}</div>}</td>
                  <td className="mono small">{s.token_prefix}…<div className={`muted ${Date.now() - new Date(s.token_created_at).getTime() > 180 * 86400_000 ? 'attention' : ''}`}>issued {relativeTime(s.token_created_at)}</div></td>
                  <td className="num">{s.received_count}</td>
                  <td className={`num ${s.rejected_count ? 'attention' : ''}`}>{s.rejected_count}</td>
                  <td className="muted small">{s.last_received_at ? relativeTime(s.last_received_at) : 'never'}</td>
                  <td className="nowrap">
                    <button className="btn-link small" onClick={async () => { const r = await api.post<{ token: string }>(`/api/event-sources/${s.id}/rotate`, {}); setSecret({ url: s.url, token: r.token, signing_secret: null }); }}>Rotate token</button>{' '}
                    <button className="btn-link small" onClick={async () => { await api.patch(`/api/event-sources/${s.id}`, { enabled: !s.enabled }); reload(); }}>{s.enabled ? 'Disable' : 'Enable'}</button>{' '}
                    <button className="btn-link small danger" onClick={async () => { if (await askReason(`Delete ${s.name}`, 'The tool will no longer be able to send events.', { danger: true, confirmLabel: 'Delete' })) { await api.del(`/api/event-sources/${s.id}`); reload(); } }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {creating && (
        <FormModal title="Add an event source" submitLabel="Create" onClose={() => setCreating(false)} onSubmit={async () => {
          const r = await api.post<{ url: string; token: string; signing_secret: string | null }>('/api/event-sources', form);
          setCreating(false);
          setSecret(r);
          reload();
        }}>
          <label className="full">Name<input required placeholder="Prometheus prod" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="full">Kind<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="full">CMDB source system <span className="muted small">(optional: match CIs by this source's ids, e.g. Azure or OP5)</span><input value={form.ci_source_system} onChange={(e) => setForm({ ...form, ci_source_system: e.target.value })} /></label>
          {form.kind === 'generic' && <label className="check full"><input type="checkbox" checked={form.signed} onChange={(e) => setForm({ ...form, signed: e.target.checked })} /> Require signed requests (Standard Webhooks)</label>}
        </FormModal>
      )}
      {secret && (
        <Modal title="Copy these now" onClose={() => setSecret(null)}>
          <p className="warn-box">The token{secret.signing_secret ? ' and signing secret are' : ' is'} shown only once.</p>
          <dl className="kv secrets">
            <dt>URL</dt><dd className="mono">{full(secret.url)}</dd>
            <dt>Token</dt><dd className="mono">{secret.token}</dd>
            {secret.signing_secret && <><dt>Signing secret</dt><dd className="mono">{secret.signing_secret}</dd></>}
          </dl>
          <p className="muted small">Send the token as <span className="mono">Authorization: Bearer …</span> or <span className="mono">X-Kernel-Token</span>. Use a header wherever the tool allows it (Alertmanager, Uptime Kuma, OP5 scripts). Only for tools that cannot set headers (Azure action groups) append <span className="mono">?token=…</span>: Kernel never logs it, but proxies and the sender's configuration may, so rotate such tokens regularly.</p>
        </Modal>
      )}
    </>
  );
}
