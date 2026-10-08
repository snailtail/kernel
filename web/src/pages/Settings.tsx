import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { formatDate, relativeTime, ROLE_LABEL } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

interface Token {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  token?: string;
}

export function SettingsPage() {
  const { user } = useSession();
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">{user.display_name} · {user.username} · {ROLE_LABEL[user.role]}</p>
        </div>
      </header>
      <PreferencesCard />
      <TokensCard />
      <SessionsCard />
      <PasswordCard />
    </>
  );
}

function PreferencesCard() {
  const { user, setPreferences } = useSession();
  const theme = user.preferences.theme ?? 'system';
  const guided = user.preferences.guided ?? true;
  return (
    <section className="card">
      <h2>Preferences</h2>
      <div className="pref-row">
        <div>
          <strong>Theme</strong>
          <p className="muted small">System follows your operating system's light or dark setting.</p>
        </div>
        <div className="toggle" role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => setPreferences({ theme: t })}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="pref-row">
        <div>
          <strong>Guided mode</strong>
          <p className="muted small">Explains each step of the problem management process and suggests what to do next.</p>
        </div>
        <label className="switch">
          <input type="checkbox" checked={guided} onChange={(e) => setPreferences({ guided: e.target.checked })} />
          <span>{guided ? 'On' : 'Off'}</span>
        </label>
      </div>
    </section>
  );
}

function PasswordCard() {
  const [form, setForm] = useState({ current: '', password: '', confirm: '' });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setMessage({ ok: false, text: 'Passwords do not match' });
    try {
      await api.post('/api/auth/password', { current: form.current, password: form.password });
      setForm({ current: '', password: '', confirm: '' });
      setMessage({ ok: true, text: 'Password changed' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    }
  };

  return (
    <section className="card">
      <h2>Change password</h2>
      <form className="form narrow" onSubmit={submit}>
        <label className="full">Current password<input type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} /></label>
        <label>New password <span className="muted small">(at least 12 characters; a passphrase works well)</span><input type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <label>Confirm<input type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} /></label>
        {message && <div className={`full ${message.ok ? 'success' : 'error'}`}>{message.text}</div>}
        <div className="actions full"><button className="btn primary" disabled={!form.current || !form.password}>Change password</button></div>
      </form>
    </section>
  );
}

function TokensCard() {
  const { meta } = useSession();
  const { data: tokens, reload } = useApi<Token[]>('/api/tokens');
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('90');
  const [created, setCreated] = useState<Token | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mcpUrl = meta.mcp_url ?? `${window.location.origin}/mcp`;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setCreated(await api.post<Token>('/api/tokens', { name, expires_in_days: expires ? Number(expires) : undefined }));
      setName('');
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const revoke = async (t: Token) => {
    if (!confirm(`Revoke token "${t.name}"? Clients using it stop working immediately.`)) return;
    await api.del(`/api/tokens/${t.id}`);
    reload();
  };

  const token = created?.token ?? '<your-token>';
  const claudeCode = `claude mcp add --transport http kernel ${mcpUrl} \\\n  --header "Authorization: Bearer ${token}"`;
  const ingestExample = `curl -X POST ${window.location.origin}/api/integrations/records \\\n  -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \\\n  -d '{"records": [{"system": "Zabbix", "kind": "event", "reference": "ZBX-4711",\n                    "service": "Payments", "summary": "Queue depth > 1000"}]}'`;
  const jsonConfig = JSON.stringify({ mcpServers: { kernel: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

  return (
    <section className="card">
      <h2>API tokens &amp; MCP</h2>
      <p className="muted">
        Personal tokens let Claude Code, Claude and other MCP clients work with Kernel as you, with your role.
        The MCP endpoint is <code>{mcpUrl}</code> (Streamable HTTP).
      </p>
      <form className="inline-form" onSubmit={create}>
        <input required placeholder="Token name, e.g. Claude Code on laptop" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={expires} onChange={(e) => setExpires(e.target.value)}>
          <option value="30">Expires in 30 days</option>
          <option value="90">Expires in 90 days</option>
          <option value="365">Expires in 1 year</option>
          <option value="">Never expires</option>
        </select>
        <button className="btn primary">Create token</button>
      </form>
      {error && <div className="error">{error}</div>}
      {created && (
        <div className="token-created">
          <strong>Copy your new token now – it will not be shown again.</strong>
          <CopyBlock text={created.token!} />
        </div>
      )}
      <h3>Connect Claude Code</h3>
      <CopyBlock text={claudeCode} />
      <h3>Other MCP clients (JSON config)</h3>
      <CopyBlock text={jsonConfig} />
      <h3>REST API</h3>
      <p className="muted small">The same token works for the REST API. See the <Link to="/api-docs">API reference</Link> or the OpenAPI document at <code>/api/openapi.json</code>.</p>
      <h3>Report incidents and events from other systems</h3>
      <p className="muted small">
        Use a token belonging to a user with the Integration role. Records with a <code>problem_ref</code> are linked to that problem;
        unlinked records feed the problem candidates list. Sending the same record again is harmless.
      </p>
      <CopyBlock text={ingestExample} />

      {tokens && tokens.length > 0 && (
        <table className="table compact">
          <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="mono">{t.prefix}…</td>
                <td>{formatDate(t.created_at)}</td>
                <td>{t.last_used_at ? relativeTime(t.last_used_at) : 'Never'}</td>
                <td>{t.expires_at ? formatDate(t.expires_at) : 'Never'}</td>
                <td><button className="btn-link danger" onClick={() => revoke(t)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <pre>{text}</pre>
      <button className="btn small" onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

interface Session { id: string; created_at: string; last_seen_at: string; ip: string; user_agent: string; current: boolean }

/** A short, readable device description from a user agent string. */
function device(ua: string) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Browser' : 'Unknown';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function SessionsCard() {
  const { data, reload } = useApi<Session[]>('/api/auth/sessions');
  const revoke = async (s: Session) => {
    await api.del(`/api/auth/sessions/${s.id}`);
    reload();
  };
  const revokeOthers = async () => {
    if (!confirm('Sign out all other sessions?')) return;
    await api.post('/api/auth/sessions/revoke-others');
    reload();
  };
  return (
    <section className="card">
      <div className="section-head">
        <h2>Active sessions</h2>
        {data && data.length > 1 && <button className="btn small" onClick={revokeOthers}>Sign out everywhere else</button>}
      </div>
      {data && (
        <table className="table compact">
          <thead><tr><th>Device</th><th>IP address</th><th>Signed in</th><th>Last active</th><th /></tr></thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>{device(s.user_agent)}{s.current && <span className="tag"> This session</span>}</td>
                <td className="mono small">{s.ip || '–'}</td>
                <td>{formatDate(s.created_at)}</td>
                <td>{relativeTime(s.last_seen_at)}</td>
                <td>{!s.current && <button className="btn-link danger" onClick={() => revoke(s)}>Sign out</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
