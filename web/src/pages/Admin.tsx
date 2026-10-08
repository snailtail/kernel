import { useState, type FormEvent } from 'react';
import { api, type Role } from '../api';
import { formatDate, relativeTime, ROLE_LABEL } from '../format';
import { useApi } from '../hooks';
import { isManager, useSession } from '../session';
import { Modal } from '../components/Modal';

interface AdminUser {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: Role;
  active: boolean;
  created_at: string;
}

export function AdminPage() {
  const { user } = useSession();
  if (!isManager(user)) return <p className="empty">Administration requires the Problem Manager or Administrator role.</p>;
  return (
    <>
      <header className="page-head"><h1>Administration</h1></header>
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
        <thead><tr><th>Username</th><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th /></tr></thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'inactive'}>
              <td className="mono">{u.username}</td>
              <td>{u.display_name}</td>
              <td>{u.email || '–'}</td>
              <td>{ROLE_LABEL[u.role]}</td>
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
    password: '',
  });
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (user) {
        const { username: _, password, ...fields } = form;
        await api.patch(`/api/users/${user.id}`, password ? { ...fields, password } : fields);
      } else {
        await api.post('/api/users', form);
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
        <label className="full">{user ? 'New password (leave empty to keep)' : 'Password'}
          <input type="password" autoComplete="new-password" required={!user} minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        {user && !self && (
          <label className="check full"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
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
