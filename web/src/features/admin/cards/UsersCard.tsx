import { useState } from 'react';
import { api, type Role } from '../../../api/client';
import { formatDate, ROLE_LABEL } from '../../../format';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import { FormModal } from '../../../components/Modal';
import { askReason } from '../../../components/Ask';
import { Link } from 'react-router';
import type { AdminUser } from '../../../api/types/admin';
import '../styles.css';

export function UsersCard() {
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
              <td className="nowrap"><button className="btn-link" onClick={() => setEditing(u)}>Edit</button> <Link to={`/admin/audit?actor_id=${u.id}`}>Activity</Link></td>
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

  const submit = async () => {
    const ci_source_systems = form.role === 'integration' ? form.sources.split(',').map((s) => s.trim()).filter(Boolean) : user?.ci_source_systems ?? [];
    const change_templates = form.role === 'integration' ? form.templates.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n)) : user?.change_templates ?? [];
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
  };

  return (
    <FormModal title={user ? `Edit ${user.username}` : 'Add user'} submitLabel="Save" onClose={onClose} onSubmit={submit}>
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
      {user && !self && (
        <div className="full danger-zone">
          <button type="button" className="btn danger small" onClick={async () => {
            const kept = await api.get<{ audit_context_days: number; security_event_days: number }>('/api/admin/privacy').catch(() => null);
            const retention = kept ? ` IP addresses and browsers in security events and the audit trail are kept for security (legitimate interest) until their retention ends: ${kept.security_event_days} and ${kept.audit_context_days} days.` : '';
            const reason = await askReason(`Erase ${user.username}`, `The account is anonymised and signed out everywhere; records keep a reference to "deleted user".${retention} Audit entries from before personal data was kept out of the trail may still name the user until they are re-based (see the security status).`, { danger: true, confirmLabel: 'Erase user' });
            if (!reason) return;
            try {
              await api.post(`/api/users/${user.id}/erase`, { reason });
              onDone();
            } catch (err) {
              setError((err as Error).message);
            }
          }}>Erase user (GDPR)</button>
        </div>
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
    </FormModal>
  );
}
