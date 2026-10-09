import { useState, type FormEvent } from 'react';
import { api, type Role } from '../api';
import { formatDate, relativeTime, ROLE_LABEL } from '../format';
import { useApi } from '../hooks';
import { isManager, useSession } from '../session';
import { Modal } from '../components/Modal';
import { askReason } from '../components/Ask';
import { Link } from 'react-router';

interface AdminUser {
  mfa_enabled: boolean;
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: Role;
  active: boolean;
  ci_source_systems: string[];
  change_templates: number[];
  created_at: string;
}

export function AdminPage() {
  const { user } = useSession();
  if (!isManager(user)) return <p className="empty">Administration requires the Problem Manager or Administrator role.</p>;
  return (
    <>
      <header className="page-head">
        <h1>Administration</h1>
        {user.role === 'admin' && <Link className="btn" to="/admin/audit">Audit trail</Link>}
      </header>
      {user.role === 'admin' && <SecurityCard />}
      {user.role === 'admin' && <WebhooksCard />}
      <SystemsCard />
      <BackupsCard />
      {user.role === 'admin' && <UsersCard />}
      <CategoriesCard />
    </>
  );
}

function UsersCard() {
  const { user: me, meta, reloadMeta } = useSession();
  const { data: users, reload } = useApi<AdminUser[]>('/api/users');
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const done = () => {
    setEditing(null);
    reload();
    reloadMeta();
  };

  return (
    <section className="card">
      <div className="section-head">
        <h2>Users</h2>
        <button className="btn primary small" onClick={() => setEditing('new')}>Add user</button>
      </div>
      <table className="table compact">
        <thead><tr><th>Username</th><th>Name</th><th>Email</th><th>Role</th><th>2FA</th><th>Status</th><th>Created</th><th /></tr></thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'inactive'}>
              <td className="mono">{u.username}</td>
              <td>{u.display_name}</td>
              <td>{u.email || '–'}</td>
              <td>{ROLE_LABEL[u.role]}</td>
              <td>{u.mfa_enabled ? '✓' : '–'}</td>
              <td>{u.active ? 'Active' : 'Deactivated'}</td>
              <td>{formatDate(u.created_at)}</td>
              <td><button className="btn-link" onClick={() => setEditing(u)}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <UserModal user={editing === 'new' ? null : editing} self={editing !== 'new' && editing.id === me.id} roles={meta.roles} onClose={() => setEditing(null)} onDone={done} />}
    </section>
  );
}

function UserModal({ user, self, roles, onClose, onDone }: { user: AdminUser | null; self: boolean; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    username: user?.username ?? '',
    display_name: user?.display_name ?? '',
    email: user?.email ?? '',
    role: user?.role ?? ('analyst' as Role),
    active: user?.active ?? true,
    sources: (user?.ci_source_systems ?? []).join(', '),
    templates: (user?.change_templates ?? []).join(', '),
    password: '',
  });
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const ci_source_systems = form.role === 'integration' ? form.sources.split(',').map((s) => s.trim()).filter(Boolean) : user?.ci_source_systems ?? [];
    const change_templates = form.role === 'integration' ? form.templates.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n)) : user?.change_templates ?? [];
    try {
      if (user) {
        const { username: _, password, sources: __, templates: ___, ...rest } = form;
        const fields = { ...rest, ci_source_systems, change_templates };
        const sourcesChanged = JSON.stringify(ci_source_systems) !== JSON.stringify(user.ci_source_systems) || JSON.stringify(change_templates) !== JSON.stringify(user.change_templates);
        const sensitive = !self && (password || sourcesChanged || fields.role !== user.role || fields.active !== user.active);
        const reason = sensitive ? await askReason(`Change ${user.username}`, "Changing someone's role, status, password, CI sources or change templates needs a reason.", { confirmLabel: 'Save change' }) : undefined;
        if (sensitive && !reason) return;
        await api.patch(`/api/users/${user.id}`, { ...(password ? { ...fields, password } : fields), reason });
      } else {
        const { sources: _, templates: __, ...rest } = form;
        await api.post('/api/users', { ...rest, ci_source_systems, change_templates });
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={user ? `Edit ${user.username}` : 'Add user'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Username<input required disabled={!!user} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label>Display name<input required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
        <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Role
          <select value={form.role} disabled={self} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
        {form.role === 'integration' && (
          <label className="full">CI source systems
            <input placeholder="vCenter, Azure" value={form.sources} onChange={(e) => setForm({ ...form, sources: e.target.value })} />
            <span className="muted small">The source systems this account may report CIs for, exactly as it names them. Empty means none.</span>
          </label>
        )}
        {form.role === 'integration' && (
          <label className="full">Standard change templates
            <input placeholder="Template ids, e.g. 3, 7" value={form.templates} onChange={(e) => setForm({ ...form, templates: e.target.value })} />
            <span className="muted small">Pre-approved templates this pipeline account may register changes from (ids under Changes → Standard changes). Empty means none.</span>
          </label>
        )}
        <label className="full">{user ? 'New password (leave empty to keep)' : 'Password'}
          <input type="password" autoComplete="new-password" required={!user} minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        {user && !self && (
          <label className="check full"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
        )}
        {user && user.mfa_enabled && (
          <div className="full">
            <button type="button" className="btn-link danger" onClick={async () => {
              const reason = await askReason(`Reset two-factor authentication`, `${user.username} will have to set up two-factor authentication again.`, { confirmLabel: 'Reset', danger: true });
              if (!reason) return;
              try { await api.post(`/api/users/${user.id}/mfa/reset`, { reason }); onDone(); } catch (err) { setError((err as Error).message); }
            }}>Reset two-factor authentication</button>
          </div>
        )}
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function CategoriesCard() {
  const { meta, reloadMeta } = useSession();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reloadMeta();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="card">
      <h2>Categories</h2>
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/categories', { name })).then(() => setName('')); }}>
        <input required placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary">Add</button>
      </form>
      {error && <div className="error">{error}</div>}
      <ul className="chip-list">
        {meta.categories.map((c) => (
          <li key={c.id} className={c.active ? '' : 'inactive'}>
            {c.name}
            <button className="btn-link small" onClick={() => run(() => api.patch(`/api/categories/${c.id}`, { active: !c.active }))}>
              {c.active ? 'Disable' : 'Enable'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface BackupStatus {
  configured: boolean;
  last_success?: string | null;
  last_failure?: string | null;
  healthy?: boolean;
  files?: { tier: string; name: string; size: number; created_at: string }[];
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} kB` : `${(bytes / 1048576).toFixed(1)} MB`;

function BackupsCard() {
  const { data } = useApi<BackupStatus>('/api/admin/backups');
  if (!data) return null;
  return (
    <section className="card">
      <div className="section-head">
        <h2>Backups</h2>
        {data.configured && <span className={`badge ${data.healthy ? 'status-resolved' : 'major'}`}>{data.healthy ? 'Healthy' : 'Attention'}</span>}
      </div>
      {!data.configured ? (
        <p className="muted">No backup directory configured (KERNEL_BACKUP_DIR).</p>
      ) : (
        <>
          <dl className="kv">
            <dt>Last successful backup</dt>
            <dd>{data.last_success ? `${formatDate(data.last_success)} (${relativeTime(data.last_success)})` : 'Never'}</dd>
            {data.last_failure && (<><dt>Last failure</dt><dd className="warn">{formatDate(data.last_failure)}</dd></>)}
          </dl>
          {data.files && data.files.length > 0 && (
            <table className="table compact">
              <thead><tr><th>Dump</th><th>Retention</th><th>Size</th><th>Created</th></tr></thead>
              <tbody>
                {data.files.map((f) => (
                  <tr key={f.tier + f.name}>
                    <td className="mono">{f.name}</td>
                    <td>{f.tier}</td>
                    <td>{formatSize(f.size)}</td>
                    <td>{formatDate(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">Restore on the Docker host with <code>scripts/restore.sh</code>; use <code>--verify</code> to test a dump without downtime.</p>
        </>
      )}
    </section>
  );
}

interface ExternalSystem { id: number; name: string; url_templates: Record<string, string>; active: boolean }

function SystemsCard() {
  const { meta } = useSession();
  const { data, reload } = useApi<ExternalSystem[]>('/api/systems');
  const [editing, setEditing] = useState<ExternalSystem | 'new' | null>(null);
  return (
    <section className="card">
      <div className="section-head">
        <h2>External systems</h2>
        <button className="btn primary small" onClick={() => setEditing('new')}>Add system</button>
      </div>
      <p className="muted small">URL templates turn linked references into links, e.g. <code>{'https://example.service-now.com/incident.do?sysparm_query=number={ref}'}</code>.</p>
      {data?.length === 0 && <p className="empty">No external systems yet.</p>}
      {data && data.length > 0 && (
        <table className="table compact">
          <thead><tr><th>System</th>{meta.link_kinds.map((k) => <th key={k}>{k}</th>)}<th /></tr></thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'inactive'}>
                <td>{s.name}</td>
                {meta.link_kinds.map((k) => <td key={k}>{s.url_templates[k] ? '✓' : '–'}</td>)}
                <td><button className="btn-link" onClick={() => setEditing(s)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <SystemModal system={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </section>
  );
}

function SystemModal({ system, onClose, onDone }: { system: ExternalSystem | null; onClose: () => void; onDone: () => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({ name: system?.name ?? '', url_templates: { ...(system?.url_templates ?? {}) }, active: system?.active ?? true });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (system) await api.put(`/api/systems/${system.id}`, form);
      else await api.post('/api/systems', form);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={system ? `Edit ${system.name}` : 'Add external system'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="full">Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ServiceNow, Jira, Zabbix…" /></label>
        {meta.link_kinds.map((k) => (
          <label key={k} className="full">URL template for {k}s
            <input value={form.url_templates[k] ?? ''} placeholder="https://…{ref}" onChange={(e) => setForm({ ...form, url_templates: { ...form.url_templates, [k]: e.target.value } })} />
          </label>
        ))}
        <label className="check full"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

interface Webhook { id: number; name: string; url: string; format: string; events: string[]; active: boolean; failed: number; last_delivered_at: string | null; secret_set_at: string; secret?: string }
interface Delivery { id: number; event: string; status: string; attempts: number; response_status: number | null; last_error: string | null; created_at: string; summary: string | null; ref: string | null }

function WebhooksCard() {
  const { data, reload } = useApi<{ webhooks: Webhook[]; events: string[]; formats: string[] }>('/api/webhooks');
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const ping = async (w: Webhook) => {
    const d = await api.post<Delivery>(`/api/webhooks/${w.id}/ping`);
    setMessage(d.status === 'ok' ? `Test delivery to ${w.name} succeeded (HTTP ${d.response_status}).` : `Test delivery to ${w.name} failed: ${d.last_error}`);
    reload();
  };
  const rotate = async (w: Webhook) => {
    if (!confirm(`Replace the signing secret of ${w.name}? Receivers must be updated with the new secret.`)) return;
    setSecret({ name: w.name, secret: (await api.post<{ secret: string }>(`/api/webhooks/${w.id}/rotate`)).secret });
    reload();
  };

  return (
    <section className="card">
      <div className="section-head">
        <h2>Webhooks</h2>
        <button className="btn primary small" onClick={() => setEditing('new')}>Add webhook</button>
      </div>
      <p className="muted small">
        Kernel POSTs problem events to these URLs, signed per <a href="https://www.standardwebhooks.com/" target="_blank" rel="noreferrer noopener">Standard Webhooks</a>
        (<code>webhook-id</code>, <code>webhook-timestamp</code>, <code>webhook-signature</code>). Payloads contain ref, title, status and a link, never long texts.
        Failed deliveries are retried with backoff. Private network addresses must be allowed with <code>KERNEL_OUTBOUND_ALLOW</code>.
      </p>
      {message && <div className={message.includes('failed') ? 'error' : 'success'}>{message}</div>}
      {data?.webhooks.length === 0 && <p className="empty">No webhooks yet.</p>}
      {data && data.webhooks.length > 0 && (
        <table className="table compact">
          <thead><tr><th>Name</th><th>URL</th><th>Format</th><th>Events</th><th>Last delivery</th><th /></tr></thead>
          <tbody>
            {data.webhooks.map((w) => (
              <tr key={w.id} className={w.active ? '' : 'inactive'}>
                <td>{w.name}{w.failed > 0 && <span className="badge major" title="Failed deliveries"> {w.failed} failed</span>}</td>
                <td className="mono small url-cell">{w.url}</td>
                <td>{w.format}</td>
                <td className="small">{w.events.length ? w.events.join(', ') : 'All'}</td>
                <td className="nowrap">{w.last_delivered_at ? relativeTime(w.last_delivered_at) : '–'}</td>
                <td className="nowrap row-links">
                  <button className="btn-link" onClick={() => ping(w)}>Test</button>
                  <button className="btn-link" onClick={() => setLog(w)}>Log</button>
                  <button className="btn-link" onClick={() => rotate(w)} title={`Secret set ${relativeTime(w.secret_set_at)}`}>Rotate secret</button>
                  <button className="btn-link" onClick={() => setEditing(w)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && data && (
        <WebhookModal
          hook={editing === 'new' ? null : editing}
          events={data.events}
          formats={data.formats}
          onClose={() => setEditing(null)}
          onDone={(created) => { setEditing(null); reload(); if (created?.secret) setSecret({ name: created.name, secret: created.secret }); }}
        />
      )}
      {log && <DeliveriesModal hook={log} onClose={() => setLog(null)} />}
      {secret && (
        <Modal title={`Signing secret – ${secret.name}`} onClose={() => setSecret(null)}>
          <p className="muted">Copy it now – it will not be shown again. Receivers use it to verify the <code>webhook-signature</code> header (Standard Webhooks libraries accept it as is).</p>
          <pre className="secret">{secret.secret}</pre>
        </Modal>
      )}
    </section>
  );
}

function WebhookModal({ hook, events, formats, onClose, onDone }: { hook: Webhook | null; events: string[]; formats: string[]; onClose: () => void; onDone: (w?: Webhook) => void }) {
  const [form, setForm] = useState({ name: hook?.name ?? '', url: hook?.url ?? '', format: hook?.format ?? 'json', events: hook?.events ?? [], active: hook?.active ?? true });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onDone(hook ? await api.put<Webhook>(`/api/webhooks/${hook.id}`, form) : await api.post<Webhook>('/api/webhooks', form));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    const reason = hook ? await askReason(`Delete ${hook.name}`, 'The webhook and its delivery log are deleted.', { confirmLabel: 'Delete webhook', danger: true }) : null;
    if (hook && reason) {
      await api.del(`/api/webhooks/${hook.id}?reason=${encodeURIComponent(reason)}`);
      onDone();
    }
  };
  const toggle = (ev: string) => setForm({ ...form, events: form.events.includes(ev) ? form.events.filter((x) => x !== ev) : [...form.events, ev] });
  return (
    <Modal title={hook ? `Edit ${hook.name}` : 'Add webhook'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Team chat" /></label>
        <label>Format
          <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
            {formats.map((f) => <option key={f} value={f}>{({ json: 'Generic JSON', slack: 'Slack', teams_workflow: 'Microsoft Teams (Workflows)', teams: 'Microsoft Teams (legacy connector)' } as Record<string, string>)[f] ?? f}</option>)}
          </select>
        </label>
        <label className="full">URL<input required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></label>
        <fieldset className="full event-picker">
          <legend>Events <span className="muted small">(none selected = all)</span></legend>
          {events.map((ev) => (
            <label key={ev} className="check"><input type="checkbox" checked={form.events.includes(ev)} onChange={() => toggle(ev)} /> {ev}</label>
          ))}
        </fieldset>
        <label className="check full"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          {hook && <button type="button" className="btn-link danger spacer-right" onClick={remove}>Delete</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function DeliveriesModal({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const { data } = useApi<Delivery[]>(`/api/webhooks/${hook.id}/deliveries`);
  return (
    <Modal title={`Deliveries – ${hook.name}`} onClose={onClose}>
      {data?.length === 0 && <p className="empty">No deliveries yet.</p>}
      {data && data.length > 0 && (
        <table className="table compact">
          <thead><tr><th>When</th><th>Event</th><th>Problem</th><th>Status</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td className="nowrap">{relativeTime(d.created_at)}</td>
                <td>{d.event}</td>
                <td className="mono">{d.ref ?? '–'}</td>
                <td title={d.last_error ?? undefined}>
                  <span className={`badge ${d.status === 'ok' ? 'status-resolved' : d.status === 'failed' ? 'major' : 'status-known_error'}`}>{d.status}</span>
                  {d.attempts > 1 && <span className="muted small"> {d.attempts} attempts</span>}
                  {d.last_error && d.status !== 'ok' && <div className="muted small">{d.last_error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function SecurityCard() {
  const { meta } = useSession();
  const { data, reload } = useApi<{ checks: { id: string; label: string; ok: boolean; detail: string }[] }>('/api/admin/security');
  const { data: policy, reload: reloadPolicy } = useApi<{ required_roles: Role[] }>('/api/admin/mfa-policy');
  const toggleRole = async (role: Role) => {
    if (!policy) return;
    const roles = policy.required_roles.includes(role) ? policy.required_roles.filter((r) => r !== role) : [...policy.required_roles, role];
    const reason = await askReason('Change two-factor policy', `Two-factor authentication will ${policy.required_roles.includes(role) ? 'no longer be' : 'be'} required for ${ROLE_LABEL[role]}.`, { confirmLabel: 'Change policy' });
    if (!reason) return;
    await api.put('/api/admin/mfa-policy', { required_roles: roles, reason });
    reloadPolicy();
    reload();
  };
  const { data: approvals, reload: reloadApprovals } = useApi<{ required: boolean }>('/api/admin/mcp-approvals');
  const toggleApprovals = async () => {
    if (!approvals) return;
    const reason = await askReason('Decisions through MCP', approvals.required ? 'Agents will be able to make decisions without approval in the web UI.' : 'Agent decisions will wait for approval in the web UI.', { confirmLabel: 'Change setting', danger: approvals.required });
    if (!reason) return;
    await api.put('/api/admin/mcp-approvals', { required: !approvals.required, reason });
    reloadApprovals();
  };
  if (!data) return null;
  const failing = data.checks.filter((c) => !c.ok).length;
  return (
    <section className="card">
      <div className="section-head">
        <h2>Security status</h2>
        <span className={`badge ${failing ? 'major' : 'status-resolved'}`}>{failing ? `${failing} to review` : 'All good'}</span>
      </div>
      <ul className="checklist">
        {data.checks.map((c) => (
          <li key={c.id} className={c.ok ? 'ok' : 'warn'}>
            <span className="check-mark" aria-hidden="true">{c.ok ? '✓' : '!'}</span>
            <div><strong>{c.label}</strong><div className="muted small">{c.detail}</div></div>
          </li>
        ))}
      </ul>
      {approvals && (
        <div className="mfa-policy">
          <h3>Decisions through MCP</h3>
          <label className="check">
            <input type="checkbox" checked={approvals.required} onChange={toggleApprovals} />
            AI agents' decisions (closing, accepting or deferring risk, marking duplicates) wait for a person to approve them in the web UI
          </label>
          {!approvals.required && <p className="warn-box">Agents act directly on a quoted confirmation, which a prompt injection could fabricate.</p>}
        </div>
      )}
      {policy && (
        <div className="mfa-policy">
          <h3>Two-factor policy</h3>
          <p className="muted small">Users in these roles must set up two-factor authentication before they can use Kernel.</p>
          <div className="chip-row">
            {meta.roles.filter((r) => r !== 'integration').map((r) => (
              <label key={r} className="check"><input type="checkbox" checked={policy.required_roles.includes(r)} onChange={() => toggleRole(r)} /> {ROLE_LABEL[r]}</label>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
