import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { formatDate, relativeTime } from '../format';
import { useApi } from '../hooks';
import { Modal } from './Modal';

interface Run { id?: number; trigger?: string; status: string; counts: Record<string, any>; errors?: { source_id?: string; error: string }[]; message: string; started_at: string; finished_at: string | null }
interface Connector {
  id: number; type: string; name: string; source_system: string; config: Record<string, any>; private_allow: string[]; schedule_minutes: number;
  enabled: boolean; next_run_at: string; running_until: string | null; has_secret: boolean; last_run: Run | null;
}

const summary = (r: Run) => {
  const c = r.counts ?? {};
  return [c.created && `${c.created} new`, c.matched && `${c.matched} matched`, c.updated && `${c.updated} updated`, c.marked_missing && `${c.marked_missing} missing`, c.events && `${c.events.reported} alerts, ${c.events.cleared} cleared`].filter(Boolean).join(' · ') || r.message;
};

/** Pull connectors (administrators): credentials are write-only, runs never overlap, every run is logged. */
export function ConnectorsCard() {
  const { data, reload } = useApi<{ types: Record<string, string>; connectors: Connector[] }>('/api/connectors');
  const [editing, setEditing] = useState<Partial<Connector> | null>(null);
  const [runs, setRuns] = useState<{ c: Connector; list: Run[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!data) return null;
  const act = async (fn: () => Promise<any>) => {
    setMessage(null);
    try {
      const r = await fn();
      setMessage(r?.message ?? (r?.status ? `Run ${r.status}` : null));
    } catch (err) {
      setMessage((err as Error).message);
    }
    reload();
  };
  return (
    <section className="card">
      <div className="section-head"><h2>Connectors</h2><button className="btn-link" onClick={() => setEditing({ type: 'op5', config: { default_ci_type: 'virtual_machine', environment: 'prod', sync_events: true }, private_allow: [], schedule_minutes: 60, enabled: true })}>+ Connector</button></div>
      <p className="muted small">Kernel fetches CIs (and current problems as alerts) from your tools on a schedule. Anything else can push with <span className="mono">POST /api/cmdb/ci-batch</span> or the MCP tool <span className="mono">sync_ci_batch</span>.</p>
      {data.connectors.length === 0 && <p className="placeholder">No connectors yet.</p>}
      <ul className="work-list">
        {data.connectors.map((c) => (
          <li key={c.id}>
            <div>
              <strong>{c.name}</strong> <span className="tag">{data.types[c.type]}</span>{!c.enabled && <span className="tag">disabled</span>}
              <div className="muted small">
                Source “{c.source_system}” · every {c.schedule_minutes} min ·{' '}
                {c.running_until && new Date(c.running_until) > new Date() ? 'running now' : c.last_run ? <>{c.last_run.status} {relativeTime(c.last_run.started_at)}: {summary(c.last_run)}</> : 'never run'}
              </div>
            </div>
            <span className="work-meta">
              <button className="btn small" onClick={() => act(() => api.post(`/api/connectors/${c.id}/test`, {}))}>Test</button>
              <button className="btn small" onClick={() => act(() => api.post(`/api/connectors/${c.id}/run`, {}))}>Run now</button>
              <button className="btn-link small" onClick={async () => setRuns({ c, list: await api.get(`/api/connectors/${c.id}/runs`) })}>Log</button>
              <button className="btn-link small" onClick={() => setEditing(c)}>Edit</button>
            </span>
          </li>
        ))}
      </ul>
      {message && <p className="hint-box">{message}</p>}
      {editing && <ConnectorEditor connector={editing} types={data.types} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
      {runs && (
        <Modal title={`${runs.c.name}: run log`} onClose={() => setRuns(null)}>
          <table className="table compact">
            <thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Result</th></tr></thead>
            <tbody>
              {runs.list.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{formatDate(r.started_at)}{r.finished_at && <div className="muted small">{Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 100) / 10} s</div>}</td>
                  <td>{r.trigger}</td>
                  <td><span className={`badge run-${r.status}`}>{r.status}</span></td>
                  <td className="small">{summary(r)}{!!r.errors?.length && <div className="muted">{r.errors.length} error(s): {r.errors.slice(0, 3).map((e) => e.error).join('; ')}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </section>
  );
}

function ConnectorEditor({ connector: c, types, onClose, onDone }: { connector: Partial<Connector>; types: Record<string, string>; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    type: c.type ?? 'op5', name: c.name ?? '', source_system: c.source_system ?? 'OP5', base_url: c.config?.base_url ?? '', default_ci_type: c.config?.default_ci_type ?? 'virtual_machine',
    environment: c.config?.environment ?? 'prod', sync_events: c.config?.sync_events ?? true, username: '', password: '', private_allow: (c.private_allow ?? []).join(', '),
    schedule_minutes: c.schedule_minutes ?? 60, enabled: c.enabled ?? true, insecure_http: c.config?.insecure_http ?? false, ca_pem: c.config?.ca_pem ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      type: form.type, name: form.name, source_system: form.source_system, schedule_minutes: Number(form.schedule_minutes), enabled: form.enabled,
      config: { base_url: form.base_url, default_ci_type: form.default_ci_type, environment: form.environment, sync_events: form.sync_events, insecure_http: form.insecure_http, ca_pem: form.ca_pem.trim() },
      private_allow: form.private_allow.split(/[\s,]+/).filter(Boolean),
      ...(form.username || form.password ? { secret: { username: form.username, password: form.password } } : {}),
    };
    try {
      if (c.id) await api.put(`/api/connectors/${c.id}`, body);
      else await api.post('/api/connectors', body);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={c.id ? `Edit ${c.name}` : 'New connector'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Type<select value={form.type} disabled={!!c.id} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="full">URL<input required type="url" placeholder="https://op5.example.com" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></label>
        <label>Username<input autoComplete="off" placeholder={c.has_secret ? 'unchanged' : ''} required={!c.id} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label>Password<input type="password" autoComplete="new-password" placeholder={c.has_secret ? 'unchanged' : ''} required={!c.id} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <label>Source system <span className="muted small">(owned by this connector)</span><input required value={form.source_system} onChange={(e) => setForm({ ...form, source_system: e.target.value })} /></label>
        <label>New CIs as<input value={form.default_ci_type} onChange={(e) => setForm({ ...form, default_ci_type: e.target.value })} /></label>
        <label>Environment<select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>{['prod', 'test', 'dev', 'other'].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Every (minutes)<input type="number" min={5} max={10080} value={form.schedule_minutes} onChange={(e) => setForm({ ...form, schedule_minutes: Number(e.target.value) })} /></label>
        <label className="full">Private network access <span className="muted small">(addresses or ranges on your LAN this connector may reach, e.g. 192.168.1.20 or 10.0.0.0/8)</span><input value={form.private_allow} onChange={(e) => setForm({ ...form, private_allow: e.target.value })} /></label>
        {form.base_url.startsWith('http://') && (
          <label className="check full warn-box"><input type="checkbox" checked={form.insecure_http} onChange={(e) => setForm({ ...form, insecure_http: e.target.checked })} /> Plain HTTP (lab only): the password is sent in clear text</label>
        )}
        <label className="full">CA certificate <span className="muted small">(optional PEM, for a server behind your own CA; verification is always on)</span><textarea rows={3} placeholder="-----BEGIN CERTIFICATE-----" value={form.ca_pem} onChange={(e) => setForm({ ...form, ca_pem: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={form.sync_events} onChange={(e) => setForm({ ...form, sync_events: e.target.checked })} /> Also fetch current problems as alerts</label>
        <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          {c.id && <button type="button" className="btn danger" onClick={async () => { await api.del(`/api/connectors/${c.id}`); onDone(); }}>Delete</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}
