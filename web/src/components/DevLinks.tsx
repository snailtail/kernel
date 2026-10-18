import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { relativeTime } from '../format';

interface DevItem { id: number; platform: Platform; repo: string; item_type: string; key: string; url: string; title: string; state: string; checks: string | null; author: string; via: string; updated_at: string }

type Platform = 'github' | 'gitlab' | 'azure_devops';
const PLATFORM: Record<Platform, string> = { github: 'GitHub', gitlab: 'GitLab', azure_devops: 'Azure DevOps' };
const TYPE: Record<string, string> = { pull_request: 'PR', issue: 'Issue', commit: 'Commit', workflow_run: 'Run', release: 'Release' };
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

interface Source { id: number; name: string; platform: Platform; base_url: string; repositories: string[]; has_token: boolean; has_ca: boolean; private_allow: string[]; enabled: boolean; received_count: number; rejected_count: number; last_received_at: string | null; webhook_url: string }
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
            <label>Private network ranges <span className="muted small">(if it is on the internal network)</span><input placeholder="10.20.0.0/16" value={form.private_allow} onChange={(e) => setForm({ ...form, private_allow: e.target.value })} /></label>
            <label>CA certificate <span className="muted small">(PEM, if an internal CA signed it)</span><textarea rows={2} value={form.ca_pem} onChange={(e) => setForm({ ...form, ca_pem: e.target.value })} /></label>
          </>
        )}
        {form.platform === 'azure_devops' && <p className="hint full small">Azure DevOps cannot sign its deliveries, so the secret is sent as a password with every delivery. That is weaker than GitHub's signature, so Kernel only accepts it over HTTPS and from the projects listed here.</p>}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn primary" onClick={create} disabled={!form.repositories.trim()}>Add {PLATFORM[form.platform]} source</button></div>
      </div>
    </section>
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
