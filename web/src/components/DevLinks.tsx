import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { relativeTime } from '../format';

interface DevItem { id: number; repo: string; item_type: string; key: string; url: string; title: string; state: string; checks: string | null; author: string; via: string; updated_at: string }

const TYPE: Record<string, string> = { pull_request: 'PR', issue: 'Issue', commit: 'Commit', workflow_run: 'Run', release: 'Release' };
const STATE_CLASS: Record<string, string> = { merged: 'dev-merged', open: 'dev-open', draft: 'dev-draft', closed: 'dev-closed', success: 'dev-ok', failure: 'dev-fail', cancelled: 'dev-closed', in_progress: 'dev-open', queued: 'dev-open' };

/** Code work on GitHub linked to a record: pull requests, issues, commits, workflow runs and releases (#32). */
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
      {items.length === 0 && <p className="placeholder">Paste a GitHub pull request or issue link, or mention {recordRef} in a PR title, branch or commit message.</p>}
      <ul className="plain-list dev-list">
        {items.map((d) => (
          <li key={d.id}>
            <span className="badge">{TYPE[d.item_type] ?? d.item_type}</span>
            <a href={d.url} target="_blank" rel="noreferrer noopener" className="dev-title">{d.title || `${d.repo} ${d.item_type === 'commit' ? d.key.slice(0, 7) : `#${d.key}`}`}</a>
            <span className={`badge ${STATE_CLASS[d.state] ?? ''}`}>{d.state}</span>
            {d.checks && <span className={`badge ${STATE_CLASS[d.checks] ?? ''}`} title="Checks">checks: {d.checks}</span>}
            <span className="muted small">{d.repo} · {d.author || '–'} · {relativeTime(d.updated_at)}{d.via === 'webhook' ? ' · linked from GitHub' : ''}</span>
            {editable && <button className="btn-icon small" aria-label="Remove link" onClick={() => api.del<DevItem[]>(`/api/records/${recordRef}/dev-links/${d.id}`).then(setItems, (err) => setError(err.message))}>×</button>}
          </li>
        ))}
      </ul>
      {editable && (
        <form className="rel-form" onSubmit={(e) => { e.preventDefault(); if (url.trim()) add(); }}>
          <input placeholder="https://github.com/owner/repo/pull/123" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="GitHub link" />
          <button className="btn">Link</button>
        </form>
      )}
      {error && <div className="error small">{error}</div>}
    </section>
  );
}

interface Source { id: number; name: string; repositories: string[]; has_token: boolean; enabled: boolean; received_count: number; rejected_count: number; last_received_at: string | null; webhook_url: string }

/** Administration: GitHub sources (webhook URL and secret, accepted repositories, an optional read-only token). */
export function DevSourcesSection() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [form, setForm] = useState({ name: 'GitHub', repositories: '', api_token: '' });
  const [created, setCreated] = useState<{ webhook_url: string; webhook_secret: string; events?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<Source[]>('/api/dev-sources').then(setSources, () => setSources(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!sources) return null;
  const create = async () => {
    setError(null);
    try {
      setCreated(await api.post('/api/dev-sources', { name: form.name, repositories: form.repositories.split(/[\s,]+/).filter(Boolean), ...(form.api_token ? { api_token: form.api_token } : {}) }));
      setForm({ name: 'GitHub', repositories: '', api_token: '' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Dev platforms</h2>
      <p className="muted small">GitHub links pull requests, commits and workflow runs to changes and problems that they mention (e.g. "Fix CHG000017"), and keeps their status current.</p>
      {sources.map((s) => (
        <div key={s.id} className="dev-source">
          <strong>{s.name}</strong> <span className="muted small">{s.repositories.join(', ')} · {s.received_count} received{s.rejected_count ? `, ${s.rejected_count} refused` : ''}{s.last_received_at ? ` · last ${relativeTime(s.last_received_at)}` : ''}{s.has_token ? ' · API token set' : ''}</span>
          <div className="mono small">{s.webhook_url}</div>
          <button className="btn small" onClick={async () => setCreated({ webhook_url: s.webhook_url, ...(await api.post<{ webhook_secret: string }>(`/api/dev-sources/${s.id}/rotate`, {})) })}>New secret</button>
          <button className="btn small danger" onClick={async () => { if (window.confirm(`Remove ${s.name}?`)) { await api.del(`/api/dev-sources/${s.id}`); load(); } }}>Remove</button>
        </div>
      ))}
      {created && (
        <div className="hint-box">
          <strong>Add this webhook in GitHub</strong> (repository or organisation → Settings → Webhooks). The secret is shown only now.
          <dl className="kv">
            <dt>Payload URL</dt><dd className="mono small">{created.webhook_url}</dd>
            <dt>Content type</dt><dd>application/json</dd>
            <dt>Secret</dt><dd className="mono small">{created.webhook_secret}</dd>
            <dt>Events</dt><dd>Pull requests, Issues, Pushes, Workflow runs, Check suites, Releases</dd>
          </dl>
        </div>
      )}
      <div className="form">
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Repositories<input placeholder="owner/repo, owner/other" value={form.repositories} onChange={(e) => setForm({ ...form, repositories: e.target.value })} /></label>
        <label className="full">Read-only API token <span className="muted small">(optional, for private repositories: fine-grained, Contents, Metadata and Pull requests: read)</span><input type="password" autoComplete="off" value={form.api_token} onChange={(e) => setForm({ ...form, api_token: e.target.value })} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn primary" onClick={create} disabled={!form.repositories.trim()}>Add GitHub source</button></div>
      </div>
    </section>
  );
}
