import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDate, relativeTime } from '../format';
import { useApi } from '../hooks';
import { CopyBlock } from './CopyBlock';
import { FormModal, Modal } from './Modal';
import { useTeams } from './Teams';
import type { Connector, ConnectorList, ConnectorRun } from '../api/types/admin';

const summary = (r: ConnectorRun) => {
  const c = r.counts ?? {};
  return [c.created && `${c.created} new`, c.matched && `${c.matched} matched`, c.updated && `${c.updated} updated`, c.marked_missing && `${c.marked_missing} missing`, c.events && `${c.events.reported} alerts, ${c.events.cleared} cleared`].filter(Boolean).join(' · ') || r.message;
};

/** Pull connectors (administrators): credentials are write-only, runs never overlap, every run is logged. */
export function ConnectorsCard() {
  const { data, reload } = useApi<ConnectorList>('/api/connectors');
  const [editing, setEditing] = useState<Partial<Connector> | null>(null);
  const [runs, setRuns] = useState<{ c: Connector; list: ConnectorRun[] } | null>(null);
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
      <div className="section-head"><h2>Connectors</h2><button className="btn-link" onClick={() => setEditing({ type: 'op5', private_allow: [], schedule_minutes: 60, retire_after_days: 14, enabled: true })}>+ Connector</button></div>
      <p className="muted small">Kernel fetches CIs (and current problems as alerts) from your tools on a schedule, and reads support mailboxes into incidents. Anything else can push with <span className="mono">POST /api/cmdb/ci-batch</span> or the MCP tool <span className="mono">sync_ci_batch</span>.</p>
      {data.connectors.length === 0 && <p className="placeholder">No connectors yet.</p>}
      <ul className="work-list">
        {data.connectors.map((c) => (
          <li key={c.id}>
            <div>
              <strong>{c.name}</strong> <span className="tag">{data.types[c.type]}</span>{!c.enabled && <span className="tag">disabled</span>}
              <div className="muted small">
                {MAILBOX.includes(c.type) ? 'Mailbox → incidents' : <>Source “{c.source_system}”</>} · every {c.schedule_minutes} min ·{' '}
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

/** Defaults for a new connector of each type. */
const NEW: Record<string, { source_system: string; config: Record<string, any> }> = {
  op5: { source_system: 'OP5', config: { default_ci_type: 'virtual_machine', environment: 'prod', sync_events: true } },
  kubernetes: { source_system: 'Kubernetes', config: { node_ci_type: 'virtual_machine', environment: 'prod', sync_events: false } },
  imap: { source_system: '', config: { port: 993, security: 'tls', folder: 'INBOX' } },
  msgraph: { source_system: '', config: { folder: 'inbox' } },
};
const MAILBOX = ['imap', 'msgraph'];

function ConnectorEditor({ connector: c, types, onClose, onDone }: { connector: Partial<Connector>; types: Record<string, string>; onClose: () => void; onDone: () => void }) {
  const initial = (type: string, cfg: Record<string, any>) => ({
    type, name: c.name ?? '', source_system: c.source_system ?? NEW[type]?.source_system ?? '', base_url: cfg.base_url ?? '', default_ci_type: cfg.default_ci_type ?? 'virtual_machine',
    environment: cfg.environment ?? 'prod', sync_events: cfg.sync_events ?? type === 'op5', username: '', password: '', token: '', private_allow: (c.private_allow ?? []).join(', '),
    schedule_minutes: c.schedule_minutes ?? 60, retire_after_days: c.retire_after_days ?? 14, enabled: c.enabled ?? true, insecure_http: cfg.insecure_http ?? false, ca_pem: cfg.ca_pem ?? '',
    exclude_namespaces: (cfg.exclude_namespaces ?? ['kube-system', 'kube-public', 'kube-node-lease']).join(', '), cluster_name: cfg.cluster_name ?? '', node_ci_type: cfg.node_ci_type ?? 'virtual_machine', owner_label: cfg.owner_label ?? '', console_url: cfg.console_url ?? '',
    // Mailboxes (#48)
    host: cfg.host ?? '', port: cfg.port ?? 993, security: cfg.security ?? 'tls', folder: cfg.folder ?? (type === 'msgraph' ? 'inbox' : 'INBOX'), processed_folder: cfg.processed_folder ?? '',
    trusted_authserv_id: cfg.trusted_authserv_id ?? '', team_id: cfg.team_id ?? null as number | null, impact: cfg.impact ?? 3, urgency: cfg.urgency ?? 3,
    tenant_id: cfg.tenant_id ?? '', mailbox: cfg.mailbox ?? '', client_id: '', client_secret: '',
  });
  const [form, setForm] = useState(() => initial(c.type ?? 'op5', c.config ?? NEW[c.type ?? 'op5']?.config ?? {}));
  const teams = useTeams();
  const k8s = form.type === 'kubernetes';
  const mail = MAILBOX.includes(form.type);
  const graph = form.type === 'msgraph';
  const submit = async () => {
    const shared = { base_url: form.base_url, environment: form.environment, sync_events: form.sync_events, ca_pem: form.ca_pem.trim() };
    const target = { folder: form.folder, processed_folder: form.processed_folder.trim(), trusted_authserv_id: form.trusted_authserv_id.trim(), team_id: form.team_id, impact: Number(form.impact), urgency: Number(form.urgency) };
    const config = graph ? { ...target, tenant_id: form.tenant_id.trim(), mailbox: form.mailbox.trim() }
      : mail ? { ...target, host: form.host.trim(), port: Number(form.port), security: form.security, ca_pem: form.ca_pem.trim() }
      : k8s
      ? { ...shared, cluster_name: form.cluster_name, node_ci_type: form.node_ci_type, owner_label: form.owner_label.trim(), console_url: form.console_url.trim(), exclude_namespaces: form.exclude_namespaces.split(/[\s,]+/).filter(Boolean) }
      : { ...shared, default_ci_type: form.default_ci_type, insecure_http: form.insecure_http };
    const secret = graph ? (form.client_id || form.client_secret ? { client_id: form.client_id.trim(), client_secret: form.client_secret } : null)
      : k8s ? (form.token ? { token: form.token.trim() } : null) : form.username || form.password ? { username: form.username, password: form.password } : null;
    const body = {
      // A mailbox reports no CIs; its source system is just its name.
      type: form.type, name: form.name, source_system: mail ? form.name : form.source_system, schedule_minutes: Number(form.schedule_minutes), retire_after_days: Number(form.retire_after_days), enabled: form.enabled,
      config, private_allow: form.private_allow.split(/[\s,]+/).filter(Boolean), ...(secret ? { secret } : {}),
    };
    if (c.id) await api.put(`/api/connectors/${c.id}`, body);
    else await api.post('/api/connectors', body);
    onDone();
  };
  const unchanged = c.has_secret ? 'unchanged' : '';
  return (
    <FormModal title={c.id ? `Edit ${c.name}` : 'New connector'} submitLabel="Save" onClose={onClose} onSubmit={submit}
      actions={c.id && <button type="button" className="btn danger" onClick={async () => { await api.del(`/api/connectors/${c.id}`); onDone(); }}>Delete</button>}>
      <label>Type<select value={form.type} disabled={!!c.id} onChange={(e) => setForm({ ...initial(e.target.value, NEW[e.target.value]?.config ?? {}), name: form.name })}>{Object.entries(types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      {mail ? (
        <>
          <p className="hint-box full">New mail becomes an incident. A reply to Kernel's mail (or with the incident's ref in the subject, like [INC000123]) becomes a comment, but only from a verified sender who takes part in the incident; other replies wait under Incidents → Inbound email to review. Auto-replies and bulk mail are ignored, and Kernel never answers mail by itself.</p>
          {graph ? (
            <>
              <label>Tenant ID<input required value={form.tenant_id} onChange={(e) => setForm({ ...form, tenant_id: e.target.value })} /></label>
              <label>Mailbox<input required type="email" placeholder="support@example.com" value={form.mailbox} onChange={(e) => setForm({ ...form, mailbox: e.target.value })} /></label>
              <label>Application (client) ID<input autoComplete="off" placeholder={unchanged} required={!c.id} value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} /></label>
              <label>Client secret<input type="password" autoComplete="new-password" placeholder={unchanged} required={!c.id} value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} /></label>
              <p className="muted small full">The app needs the application permission Mail.ReadWrite; limit it to this mailbox with an application access policy in Exchange Online.</p>
            </>
          ) : (
            <>
              <label>Server<input required placeholder="imap.example.com" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></label>
              <label>Port<input type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} /></label>
              <label>Security<select value={form.security} onChange={(e) => setForm({ ...form, security: e.target.value, port: e.target.value === 'tls' ? 993 : 143 })}><option value="tls">TLS (993)</option><option value="starttls">STARTTLS (143)</option><option value="plain">None (lab only)</option></select></label>
              <label>Username<input autoComplete="off" placeholder={unchanged} required={!c.id} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
              <label>Password<input type="password" autoComplete="new-password" placeholder={unchanged} required={!c.id} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
              {form.security === 'plain' && <p className="warn-box full">Without TLS the password and the mail travel in clear text. Only for a lab.</p>}
            </>
          )}
          <label>Folder<input required value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} /></label>
          <label>Move handled mail to <span className="muted small">(optional folder; else only marked read)</span><input value={form.processed_folder} onChange={(e) => setForm({ ...form, processed_folder: e.target.value })} /></label>
          <label className="full">Trusted mail server <span className="muted small">(the authserv-id in its Authentication-Results header; without it no sender counts as verified)</span><input placeholder="mx.example.com" value={form.trusted_authserv_id} onChange={(e) => setForm({ ...form, trusted_authserv_id: e.target.value })} /></label>
          <label>New incidents go to<select value={form.team_id ?? ''} onChange={(e) => setForm({ ...form, team_id: e.target.value ? Number(e.target.value) : null })}><option value="">No team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label>Impact<select value={form.impact} onChange={(e) => setForm({ ...form, impact: Number(e.target.value) })}><option value={1}>1 High</option><option value={2}>2 Medium</option><option value={3}>3 Low</option></select></label>
          <label>Urgency<select value={form.urgency} onChange={(e) => setForm({ ...form, urgency: Number(e.target.value) })}><option value={1}>1 High</option><option value={2}>2 Medium</option><option value={3}>3 Low</option></select></label>
        </>
      ) : k8s ? (
        <>
          <p className="hint-box full">Kernel reads the cluster with a read-only ServiceAccount: list on nodes, namespaces and workloads, never Secrets, ConfigMaps or pods. Apply the manifest below, then paste the API server, its CA and the token. <strong>Test</strong> then shows per kind whether the token may read it.</p>
          <RbacManifest clusterName={form.cluster_name} events={form.sync_events} />
          <label className="full">API server<input required type="url" placeholder="https://k8s.example.com:6443" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></label>
          <label className="full">ServiceAccount token<input type="password" autoComplete="new-password" placeholder={unchanged} required={!c.id} value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} /></label>
          <label>Cluster name<input required maxLength={100} placeholder="prod-aks-1" value={form.cluster_name} onChange={(e) => setForm({ ...form, cluster_name: e.target.value })} /></label>
          <label>Nodes as<input value={form.node_ci_type} onChange={(e) => setForm({ ...form, node_ci_type: e.target.value })} /></label>
        </>
      ) : (
        <>
          <label className="full">URL<input required type="url" placeholder="https://op5.example.com" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></label>
          <label>Username<input autoComplete="off" placeholder={unchanged} required={!c.id} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label>Password<input type="password" autoComplete="new-password" placeholder={unchanged} required={!c.id} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label>New CIs as<input value={form.default_ci_type} onChange={(e) => setForm({ ...form, default_ci_type: e.target.value })} /></label>
        </>
      )}
      {!mail && <label>Source system <span className="muted small">(owned by this connector)</span><input required value={form.source_system} onChange={(e) => setForm({ ...form, source_system: e.target.value })} /></label>}
      {!mail && <label>Environment<select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>{['prod', 'test', 'dev', 'other'].map((x) => <option key={x}>{x}</option>)}</select></label>}
      <label>Every (minutes)<input type="number" min={5} max={10080} value={form.schedule_minutes} onChange={(e) => setForm({ ...form, schedule_minutes: Number(e.target.value) })} /></label>
      {!mail && <label>Propose retiring after (days missing)<input type="number" min={1} max={365} value={form.retire_after_days} onChange={(e) => setForm({ ...form, retire_after_days: Number(e.target.value) })} /></label>}
      <label className="full">Private network access <span className="muted small">(addresses or ranges on your LAN this connector may reach, e.g. 192.168.1.20 or 10.0.0.0/8)</span><input value={form.private_allow} onChange={(e) => setForm({ ...form, private_allow: e.target.value })} /></label>
      {!k8s && form.base_url.startsWith('http://') && (
        <label className="check full warn-box"><input type="checkbox" checked={form.insecure_http} onChange={(e) => setForm({ ...form, insecure_http: e.target.checked })} /> Plain HTTP (lab only): the password is sent in clear text</label>
      )}
      {!graph && <label className="full">CA certificate <span className="muted small">{k8s ? '(PEM: most clusters use their own CA; verification is always on)' : '(optional PEM, for a server behind your own CA; verification is always on)'}</span><textarea rows={3} placeholder="-----BEGIN CERTIFICATE-----" value={form.ca_pem} onChange={(e) => setForm({ ...form, ca_pem: e.target.value })} /></label>}
      {k8s && (
        <>
          <label>Owner label <span className="muted small">(optional, kept as a tag)</span><input placeholder="team" value={form.owner_label} onChange={(e) => setForm({ ...form, owner_label: e.target.value })} /></label>
          <label className="full">Leave out namespaces <span className="muted small">(no CIs, workloads or alerts from these)</span><input value={form.exclude_namespaces} onChange={(e) => setForm({ ...form, exclude_namespaces: e.target.value })} /></label>
          <label className="full">Dashboard link <span className="muted small">(optional, with {'{cluster}'}, {'{kind}'}, {'{namespace}'} and {'{name}'})</span><input placeholder="https://rancher.example.com/c/{cluster}/explorer/{kind}/{namespace}/{name}" value={form.console_url} onChange={(e) => setForm({ ...form, console_url: e.target.value })} /></label>
        </>
      )}
      {!mail && <label className="check"><input type="checkbox" checked={form.sync_events} onChange={(e) => setForm({ ...form, sync_events: e.target.checked })} /> {k8s ? 'Warning events (crash loops, out of memory, scheduling) as alerts' : 'Also fetch current problems as alerts'}</label>}
      <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
    </FormModal>
  );
}

/** The least-privilege manifest for the settings in the form, ready to copy (#112). */
function RbacManifest({ clusterName, events }: { clusterName: string; events: boolean }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      api.get<{ text: string }>(`/api/connectors/types/kubernetes/setup?${new URLSearchParams({ cluster_name: clusterName, sync_events: String(events) })}`).then((r) => setText(r.text)).catch(() => setText(''));
    }, 300);
    return () => clearTimeout(t);
  }, [clusterName, events]);
  if (!text) return null;
  return (
    <details className="full">
      <summary>Read-only access for the cluster (kubectl apply -f kernel-reader.yaml)</summary>
      <CopyBlock text={text} />
      <p className="muted small">Token: <span className="mono">kubectl -n kernel get secret kernel-reader-token -o jsonpath='{'{.data.token}'}' | base64 -d</span>. CA: the same with <span className="mono">{'{.data.ca\\.crt}'}</span>.</p>
    </details>
  );
}
