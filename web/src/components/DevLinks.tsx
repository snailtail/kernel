import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { relativeTime } from '../format';

interface DevItem { id: number; platform: Platform; repo: string; item_type: string; key: string; url: string; title: string; state: string; checks: string | null; author: string; environment: string; via: string; updated_at: string }

type Platform = 'github' | 'gitlab' | 'azure_devops';
const PLATFORM: Record<Platform, string> = { github: 'GitHub', gitlab: 'GitLab', azure_devops: 'Azure DevOps' };
const TYPE: Record<string, string> = { pull_request: 'PR', issue: 'Issue', commit: 'Commit', workflow_run: 'Run', release: 'Release', deployment: 'Deploy' };
// Each platform's own words for the same kinds of item.
const TYPE_ON: Record<Platform, Record<string, string>> = { github: {}, gitlab: { pull_request: 'MR', workflow_run: 'Pipeline' }, azure_devops: { issue: 'Work item', workflow_run: 'Pipeline' } };
const typeLabel = (d: DevItem) => TYPE_ON[d.platform]?.[d.item_type] ?? TYPE[d.item_type] ?? d.item_type;
const STATE_CLASS: Record<string, string> = { merged: 'dev-merged', open: 'dev-open', draft: 'dev-draft', closed: 'dev-closed', success: 'dev-ok', failure: 'dev-fail', cancelled: 'dev-closed', in_progress: 'dev-open', queued: 'dev-open', active: 'dev-open', done: 'dev-closed', resolved: 'dev-closed' };

const title = (d: DevItem) => d.title || `${d.repo} ${d.item_type === 'commit' ? d.key.slice(0, 7) : `#${d.key}`}`;

/** Code work on GitHub, GitLab or Azure DevOps linked to a record: pull requests, issues, commits, runs and releases (#32). */
export function DevLinksPanel({ recordRef, editable }: { recordRef: string; editable: boolean }) {
  const [items, setItems] = useState<DevItem[] | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<DevItem[]>(`/api/records/${recordRef}/dev-links`).then(setItems, () => setItems([])), [recordRef]);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    setError(null);
    try {
      setItems(await api.post<DevItem[]>(`/api/records/${recordRef}/dev-links`, { url: url.trim() }));
      setUrl('');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!items) return null;
  if (!items.length && !editable) return null;
  return (
    <section className="card">
      <h2>Code</h2>
      {items.length === 0 && <p className="placeholder">Paste a GitHub, GitLab or Azure DevOps link to a pull request, issue or work item, or mention {recordRef} in a PR title, branch or commit message.</p>}
      <ul className="plain-list dev-list">
        {items.map((d) => (
          <li key={d.id}>
            <span className="badge" title={PLATFORM[d.platform]}>{typeLabel(d)}</span>
            {d.url
              ? <a href={d.url} target="_blank" rel="noreferrer noopener" className="dev-title">{title(d)}</a>
              : <span className="dev-title">{title(d)}</span>}
            <span className={`badge ${STATE_CLASS[d.state] ?? ''}`}>{d.state}</span>
            {d.checks && <span className={`badge ${STATE_CLASS[d.checks] ?? ''}`} title="Checks">checks: {d.checks}</span>}
            {d.item_type === 'deployment' && d.environment && <span className="badge" title="Environment">{d.environment}</span>}
            <span className="muted small">{PLATFORM[d.platform] ?? d.platform} · {d.repo} · {d.author || '–'} · {relativeTime(d.updated_at)}{d.via === 'webhook' ? ` · linked from ${PLATFORM[d.platform] ?? d.platform}` : ''}</span>
            {editable && <button className="btn-icon small" aria-label="Remove link" onClick={() => api.del<DevItem[]>(`/api/records/${recordRef}/dev-links/${d.id}`).then(setItems, (err) => setError(err.message))}>×</button>}
          </li>
        ))}
      </ul>
      {editable && (
        <form className="rel-form" onSubmit={(e) => { e.preventDefault(); if (url.trim()) add(); }}>
          <input placeholder="https://github.com/owner/repo/pull/123" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Link to a pull request, issue or work item" />
          <button className="btn">Link</button>
        </form>
      )}
      {error && <div className="error small">{error}</div>}
    </section>
  );
}

interface Source { id: number; name: string; platform: Platform; base_url: string; repositories: string[]; has_token: boolean; has_ca: boolean; private_allow: string[]; has_status_token: boolean; post_status: boolean; enabled: boolean; received_count: number; rejected_count: number; last_received_at: string | null; webhook_url: string }
interface Created { platform: Platform; webhook_url: string; webhook_secret: string; events?: string[] }

// What each platform needs: the allowlist's shape, a read-only token and where the webhook is set up.
const SETUP: Record<Platform, { scopes: string; scopePlaceholder: string; token: string; where: string }> = {
  github: { scopes: 'Repositories', scopePlaceholder: 'owner/repo, owner/other', token: 'fine-grained, Contents, Metadata and Pull requests: read', where: 'repository or organisation → Settings → Webhooks' },
  gitlab: { scopes: 'Projects', scopePlaceholder: 'group/project, group/subgroup/other', token: 'a project or group access token with read_api', where: 'project or group → Settings → Webhooks' },
  azure_devops: { scopes: 'Organisation/project', scopePlaceholder: 'contoso/Web Shop', token: 'a PAT with Code, Work Items and Build: read', where: 'project settings → Service hooks → Web Hooks, once per event' },
};
const blank = (platform: Platform = 'github') => ({ platform, name: PLATFORM[platform], base_url: '', repositories: '', api_token: '', private_allow: '', ca_pem: '' });

/** Administration: dev platform sources (webhook URL and secret, accepted repositories or projects, a read-only token). */
export function DevSourcesSection() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [form, setForm] = useState(blank());
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<Source[]>('/api/dev-sources').then(setSources, () => setSources(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!sources) return null;
  const setup = SETUP[form.platform];
  const selfHosted = form.platform === 'gitlab' && !!form.base_url.trim() && !/^https:\/\/gitlab\.com\/?$/.test(form.base_url.trim());
  const create = async () => {
    setError(null);
    const list = (v: string) => v.split(form.platform === 'azure_devops' ? /\s*[,\n]\s*/ : /[\s,]+/).map((x) => x.trim()).filter(Boolean);
    try {
      setCreated(await api.post<Created>('/api/dev-sources', {
        name: form.name, platform: form.platform, repositories: list(form.repositories),
        ...(form.platform === 'gitlab' && form.base_url.trim() ? { base_url: form.base_url.trim() } : {}),
        ...(form.api_token ? { api_token: form.api_token } : {}),
        ...(selfHosted && form.private_allow.trim() ? { private_allow: list(form.private_allow) } : {}),
        ...(selfHosted && form.ca_pem.trim() ? { ca_pem: form.ca_pem.trim() } : {}),
      }));
      setForm(blank(form.platform));
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Dev platforms</h2>
      <p className="muted small">GitHub, GitLab and Azure DevOps link pull requests, commits and pipeline runs to changes and problems that they mention (e.g. "Fix CHG000017"), and keep their status current.</p>
      {sources.map((s) => (
        <div key={s.id} className="dev-source">
          <strong>{s.name}</strong> {s.name !== PLATFORM[s.platform] && <span className="badge">{PLATFORM[s.platform] ?? s.platform}</span>}
          <span className="muted small">{s.platform === 'gitlab' && s.base_url !== 'https://gitlab.com' ? `${s.base_url} · ` : ''}{s.repositories.join(', ')} · {s.received_count} received{s.rejected_count ? `, ${s.rejected_count} refused` : ''}{s.last_received_at ? ` · last ${relativeTime(s.last_received_at)}` : ''}{s.has_token ? ' · API token set' : ''}</span>
          <div className="mono small">{s.webhook_url}</div>
          <button className="btn small" onClick={async () => setCreated({ platform: s.platform, webhook_url: s.webhook_url, ...(await api.post<{ webhook_secret: string }>(`/api/dev-sources/${s.id}/rotate`, {})) })}>New secret</button>
          <button className="btn small danger" onClick={async () => { if (window.confirm(`Remove ${s.name}?`)) { await api.del(`/api/dev-sources/${s.id}`); load(); } }}>Remove</button>
          <SourceDetails source={s} onChange={load} />
        </div>
      ))}
      {created && <WebhookSetup created={created} />}
      <div className="form">
        <label>Platform
          <select value={form.platform} onChange={(e) => setForm(blank(e.target.value as Platform))}>
            {(Object.keys(PLATFORM) as Platform[]).map((p) => <option key={p} value={p}>{PLATFORM[p]}</option>)}
          </select>
        </label>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        {form.platform === 'gitlab' && (
          <label className="full">Address <span className="muted small">(leave empty for gitlab.com)</span><input placeholder="https://gitlab.example.com" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></label>
        )}
        <label className="full">{setup.scopes}<input placeholder={setup.scopePlaceholder} value={form.repositories} onChange={(e) => setForm({ ...form, repositories: e.target.value })} /></label>
        <label className="full">Read-only API token <span className="muted small">(optional, for private projects: {setup.token})</span><input type="password" autoComplete="off" value={form.api_token} onChange={(e) => setForm({ ...form, api_token: e.target.value })} /></label>
        {selfHosted && (
          <>
            <label>Private network ranges <span className="muted small">(if it is on the internal network)</span><input placeholder="Its subnet, in CIDR notation" value={form.private_allow} onChange={(e) => setForm({ ...form, private_allow: e.target.value })} /></label>
            <label>CA certificate <span className="muted small">(PEM, if an internal CA signed it)</span><textarea rows={2} value={form.ca_pem} onChange={(e) => setForm({ ...form, ca_pem: e.target.value })} /></label>
          </>
        )}
        {form.platform === 'azure_devops' && <p className="hint full small">Azure DevOps cannot sign its deliveries, so the secret is sent as a password with every delivery. That is weaker than GitHub's signature, so Kernel only accepts it over HTTPS and from the projects listed here. Behind a proxy or tunnel that terminates TLS, set <span className="mono">KERNEL_TRUST_PROXY</span> so Kernel sees the request as HTTPS.</p>}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn primary" onClick={create} disabled={!form.repositories.trim()}>Add {PLATFORM[form.platform]} source</button></div>
      </div>
    </section>
  );
}

interface Target { id: number; repo: string; environment: string; cis: string[]; production: boolean; register_change: boolean; template_name: string | null }
const STATUS_TOKEN: Record<Platform, string> = {
  github: 'a fine-grained token with Commit statuses: write, and nothing else',
  gitlab: 'a project access token with the api scope, on the projects listed here only',
  azure_devops: 'a PAT with Code (Status) only',
};

/**
 * One source's deployment targets (which CIs a deploy changes; a production target may register standard changes)
 * and the opt-in to post the change status back on pull requests.
 */
function SourceDetails({ source: s, onChange }: { source: Source; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Target[]>([]);
  const [templates, setTemplates] = useState<{ id: number; name: string; active: boolean }[]>([]);
  const [form, setForm] = useState({ repo: s.repositories[0] ?? '', environment: 'production', cis: '', production: true, register_change: false, template_id: '' });
  const [statusToken, setStatusToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<Target[]>(`/api/dev-sources/${s.id}/targets`).then(setTargets, () => setTargets([])), [s.id]);
  useEffect(() => {
    if (!open) return;
    load();
    api.get<{ id: number; name: string; active: boolean }[]>('/api/change-templates').then((t) => setTemplates(t.filter((x) => x.active)), () => setTemplates([]));
  }, [open, load]);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError((err as Error).message); }
  };
  if (!open) return <button className="btn small" onClick={() => setOpen(true)}>Deployments and status…</button>;
  const addTarget = () => run(async () => {
    await api.post(`/api/dev-sources/${s.id}/targets`, {
      repo: form.repo.trim(), environment: form.environment.trim(), cis: form.cis.split(/[\s,]+/).filter(Boolean), production: form.production,
      register_change: form.production && form.register_change, template_id: form.register_change && form.template_id ? Number(form.template_id) : null,
    });
    setForm({ ...form, cis: '', register_change: false });
    load();
  });
  const saveStatus = (body: object) => run(async () => { await api.patch(`/api/dev-sources/${s.id}`, body); setStatusToken(''); onChange(); });
  return (
    <div className="dev-source-details full">
      <h3>Deployment targets</h3>
      <p className="muted small">Which CIs and services a deploy to an environment changes. A successful deploy to a production target can register a standard change from a pre-approved template, with the pull requests it contained.</p>
      {targets.map((t) => (
        <div key={t.id} className="dev-source">
          <strong>{t.repo} → {t.environment}</strong>
          {t.production && <span className="badge">production</span>}
          <span className="muted small">{t.cis.join(', ') || 'no CIs'}{t.register_change ? ` · registers "${t.template_name}"` : ''}</span>
          <button className="btn small danger" onClick={() => run(async () => { await api.del(`/api/dev-targets/${t.id}`); load(); })}>Remove</button>
        </div>
      ))}
      <div className="form">
        <label>Repository<input value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} list={`repos-${s.id}`} /></label>
        <datalist id={`repos-${s.id}`}>{s.repositories.map((r) => <option key={r} value={r} />)}</datalist>
        <label>Environment<input value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} /></label>
        <label className="full">CIs and services <span className="muted small">(refs, e.g. SVC000003 CI000012)</span><input value={form.cis} onChange={(e) => setForm({ ...form, cis: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={form.production} onChange={(e) => setForm({ ...form, production: e.target.checked, register_change: e.target.checked && form.register_change })} /> Production</label>
        {form.production && (
          <label className="check"><input type="checkbox" checked={form.register_change} onChange={(e) => setForm({ ...form, register_change: e.target.checked })} /> A successful deploy registers a standard change</label>
        )}
        {form.production && form.register_change && (
          <label className="full">Standard change template<select value={form.template_id} onChange={(e) => setForm({ ...form, template_id: e.target.value })}>
            <option value="">Choose…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
        )}
        <div className="actions full"><button type="button" className="btn" onClick={addTarget} disabled={!form.repo.trim() || !form.environment.trim()}>Add target</button></div>
      </div>
      <h3>Status on pull requests</h3>
      <p className="muted small">Posts <span className="mono">kernel/change</span> on pull requests linked to a change: authorised within its window, outside it, or not yet authorised. Teams can make it a required check. It uses its own token, {STATUS_TOKEN[s.platform]}, so reading never needs write access.</p>
      <div className="form">
        <label className="full">Status token {s.has_status_token && <span className="muted small">(set; enter a new one to replace it)</span>}<input type="password" autoComplete="off" value={statusToken} onChange={(e) => setStatusToken(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={s.post_status} disabled={!s.has_status_token && !statusToken} onChange={(e) => saveStatus({ post_status: e.target.checked, ...(statusToken ? { status_token: statusToken } : {}) })} /> Post the change status</label>
        <div className="actions full">
          {statusToken && <button type="button" className="btn" onClick={() => saveStatus({ status_token: statusToken })}>Save token</button>}
          {s.has_status_token && <button type="button" className="btn danger" onClick={() => saveStatus({ status_token: '', post_status: false })}>Remove token</button>}
          <button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

/** Where to paste the webhook URL and the secret, in each platform's own terms. The secret is shown only now. */
function WebhookSetup({ created }: { created: Created }) {
  const setup = SETUP[created.platform] ?? SETUP.github;
  return (
    <div className="hint-box">
      <strong>Add this webhook in {PLATFORM[created.platform]}</strong> ({setup.where}). The secret is shown only now.
      <dl className="kv">
        <dt>{created.platform === 'github' ? 'Payload URL' : 'URL'}</dt><dd className="mono small">{created.webhook_url}</dd>
        {created.platform === 'github' && <><dt>Content type</dt><dd>application/json</dd><dt>Secret</dt><dd className="mono small">{created.webhook_secret}</dd></>}
        {created.platform === 'gitlab' && <><dt>Secret token</dt><dd className="mono small">{created.webhook_secret}</dd></>}
        {created.platform === 'azure_devops' && <><dt>Basic authentication</dt><dd>user name <span className="mono small">kernel</span>, password <span className="mono small">{created.webhook_secret}</span></dd></>}
        {created.events && <><dt>Events</dt><dd>{created.events.join(', ')}</dd></>}
      </dl>
    </div>
  );
}
