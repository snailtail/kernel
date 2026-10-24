import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../../api/client';
import { AttachmentsPanel } from '../../components/Attachments';
import { TYPE_LABEL } from '../../components/Knowledge';
import { Markdown } from '../../components/Markdown';
import { FormModal } from '../../components/Modal';
import { richPaste } from '../../components/RichPaste';
import { formatDate, relativeTime } from '../../format';
import { useListToolkit } from '../../components/list/ListToolkit';
import { useColumns, type ColumnKey } from '../../components/list/columns';
import { SavedViews } from '../../components/SavedViews';
import { useApi, useListParams, useOpenOnNew, useRecord, useSearchText } from '../../hooks';
import { canEdit, isManager, useSession } from '../../session';
import { HistoryPanel } from '../../components/History';
import type { Article, ArticleRow, ArticleType } from '../../api/types/knowledge';
import './styles.css';

const STATUS_CLASS: Record<string, string> = { draft: 'status-new', published: 'status-resolved', retired: 'status-closed' };

export function ArticleStatus({ status }: { status: string }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? ''}`}>{status}</span>;
}

const ARTICLE_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'audience', label: 'Audience' }, { key: 'used', label: 'Used' },
  { key: 'helpful', label: 'Helpful' }, { key: 'updated', label: 'Updated' },
];

export function KnowledgePage() {
  const { user } = useSession();
  const { params, set } = useListParams();
  const [q, setQ] = useSearchText({ trim: true });
  const [creating, setCreating] = useState(false);
  useOpenOnNew(() => setCreating(true));
  const navigate = useNavigate();
  const { data, loading, refresh } = useApi<ArticleRow[]>(`/api/articles?${params}`);
  const writer = canEdit(user);
  const tk = useListToolkit({ list: 'knowledge', rows: data, idOf: (a) => a.ref, hrefOf: (a) => `/knowledge/${a.ref}`, filter: params.toString(), pageSize: 50, onChanged: refresh });
  const cols = useColumns('knowledge', ARTICLE_COLUMNS);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Knowledge</h1>
          <p className="muted">Workarounds and solutions people can find when they need them. Known errors publish here in one step.</p>
        </div>
        <SavedViews list="knowledge" />
        <div className="head-actions">{writer && <button className="btn primary page-new" onClick={() => setCreating(true)}>New article</button>}</div>
      </header>
      <div className="filters">
        <input className="search" placeholder="Search articles…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('status') ?? 'published'} onChange={(e) => set('status', e.target.value === 'published' ? '' : e.target.value)}>
          <option value="published">Published</option>
          {writer && <option value="draft">Drafts</option>}
          <option value="retired">Retired</option>
          <option value="all">All</option>
        </select>
        <select value={params.get('article_type') ?? ''} onChange={(e) => set('article_type', e.target.value)}>
          <option value="">Any type</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="check small"><input type="checkbox" checked={params.get('due_for_review') === 'true'} onChange={(e) => set('due_for_review', e.target.checked ? 'true' : '')} /> Due for review</label>
        {cols.picker}
      </div>
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {data?.length === 0 ? (
          <p className="empty">{params.get('q') ? 'No articles match.' : 'No articles yet. Publish a known error from its problem, or write one here.'}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Ref</th><th>Title</th><th data-col="type">Type</th><th data-col="status">Status</th><th className="hide-sm" data-col="audience">Audience</th><th className="hide-sm" data-col="used">Used</th><th className="hide-sm" data-col="helpful">Helpful</th><th className="hide-sm" data-col="updated">Updated</th></tr></thead>
              <tbody>
                {data?.map((a, n) => (
                  <tr key={a.ref} {...tk.rowProps(a, n)}>
                    {tk.selectAll && <td className="check-col">{tk.select(a, n)}</td>}
                    <td className="mono nowrap"><Link to={`/knowledge/${a.ref}`}>{a.ref}</Link></td>
                    <td className="title-cell"><Link to={`/knowledge/${a.ref}`}>{a.title}</Link>{a.due_for_review && <span className="badge warn-badge" title={`Review was due ${a.review_by}`}>review</span>}</td>
                    <td className="muted" data-col="type">{TYPE_LABEL[a.article_type]}</td>
                    <td data-col="status"><ArticleStatus status={a.status} /></td>
                    <td className="hide-sm muted" data-col="audience">{a.audience === 'end_users' ? 'End users' : 'Internal'}</td>
                    <td className="hide-sm" data-col="used">{a.used_count || '–'}</td>
                    <td className="hide-sm" data-col="helpful">{a.helpful + a.not_helpful ? `${Math.round((a.helpful / (a.helpful + a.not_helpful)) * 100)}%` : '–'}</td>
                    <td className="hide-sm muted nowrap" data-col="updated">{relativeTime(a.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {tk.bar}
      {creating && <ArticleModal onClose={() => setCreating(false)} onDone={(a) => navigate(`/knowledge/${a.ref}`)} />}
    </>
  );
}

export function ArticlePage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: a, setData, error, actionError, run } = useRecord<Article>(`/api/articles/${ref}`);
  const [editing, setEditing] = useState(false);
  const [ciRef, setCiRef] = useState('');
  if (error) return <div className="error">{error}</div>;
  if (!a) return null;
  const writer = canEdit(user);
  const go = (to: string) => run(() => api.post(`/api/articles/${a.ref}/transition`, { to }));
  const canPublish = writer && (a.audience !== 'end_users' || isManager(user));
  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/knowledge">Knowledge</Link> / <span className="mono">{a.ref}</span></div>
        <h1>{a.title}</h1>
        <div className="badges">
          <ArticleStatus status={a.status} />
          <span className="badge">{TYPE_LABEL[a.article_type]}</span>
          <span className="badge">{a.audience === 'end_users' ? 'For end users' : 'Internal'}</span>
          {a.due_for_review && <span className="badge warn-badge">Review due {a.review_by}</span>}
        </div>
        {writer && (
          <div className="head-actions">
            {a.status === 'draft' && canPublish && <button className="btn primary" onClick={() => go('published')}>Publish</button>}
            {a.status === 'draft' && !canPublish && <span className="muted small">A manager publishes articles for end users.</span>}
            {a.status === 'published' && <button className="btn" onClick={() => go('retired')}>Retire</button>}
            {a.status === 'retired' && !a.synced_with_problem && <button className="btn" onClick={() => go('draft')}>Back to draft</button>}
            {!a.synced_with_problem && a.status !== 'retired' && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
          </div>
        )}
      </header>
      {actionError && <div className="error">{actionError}</div>}
      {a.synced_with_problem && a.problem_ref && (
        <p className="hint-box">This article follows known error <Link to={`/problems/${a.problem_ref}`}>{a.problem_ref}</Link>: change its symptoms, cause or workaround there. It is retired when the problem is resolved.</p>
      )}
      <div className="problem-grid">
        <div className="problem-main">
          <section className="card article-body">
            {a.body.trim() ? <Markdown text={a.body} /> : <p className="placeholder">Nothing written yet.</p>}
          </section>
          {a.status === 'published' && (
            <section className="card feedback-card">
              <span>Was this helpful?</span>
              <button className={`btn small ${a.my_feedback === true ? 'primary' : ''}`} onClick={() => run(() => api.post(`/api/articles/${a.ref}/feedback`, { helpful: true }))}>Yes</button>
              <button className={`btn small ${a.my_feedback === false ? 'primary' : ''}`} onClick={() => run(() => api.post(`/api/articles/${a.ref}/feedback`, { helpful: false }))}>No</button>
              <span className="muted small">{a.helpful} yes · {a.not_helpful} no · used for {a.used_count} incident{a.used_count === 1 ? '' : 's'}</span>
            </section>
          )}
          <section className="card">
            <h2>History</h2>
            <ul className="activity">
              {a.activity.map((x) => (
                <li key={x.id}>
                  <strong>{x.user_name ?? 'System'}</strong> {x.kind === 'status' ? `${x.data?.from ?? ''} → ${x.data?.to ?? ''}${x.body ? `: ${x.body}` : ''}` : x.body} <span className="muted small">{relativeTime(x.created_at)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="problem-side">
          <section className="card">
            <h2>Details</h2>
            <dl className="kv details">
              <dt>Owner</dt><dd>{a.owner ?? '–'}</dd>
              <dt>Review by</dt><dd>{a.review_by ?? '–'}</dd>
              <dt>Published</dt><dd>{a.published_at ? formatDate(a.published_at) : '–'}</dd>
              {a.source_incident_ref && <><dt>From incident</dt><dd><Link to={`/incidents/${a.source_incident_ref}`}>{a.source_incident_ref}</Link></dd></>}
            </dl>
          </section>
          <section className="card">
            <h2>Applies to</h2>
            {a.cis.length === 0 && <p className="placeholder">No CIs or services. Linking them makes the article show up for incidents on them.</p>}
            <ul className="plain-list">
              {a.cis.map((c) => (
                <li key={c.ref} className="affected">
                  <Link to={`/cis/${c.ref}`}>{c.name}</Link>
                  {writer && <button className="btn-icon small" aria-label={`Remove ${c.ref}`} onClick={() => run(() => api.del(`/api/articles/${a.ref}/links/${c.ref}`))}>×</button>}
                </li>
              ))}
            </ul>
            {writer && (
              <form className="rel-form" onSubmit={(e) => { e.preventDefault(); if (ciRef.trim()) run(() => api.post(`/api/articles/${a.ref}/links`, { ci: ciRef.trim() })).then(() => setCiRef('')); }}>
                <input placeholder="CI… or SVC…" value={ciRef} onChange={(e) => setCiRef(e.target.value)} aria-label="CI or service ref" />
                <button className="btn">Add</button>
              </form>
            )}
          </section>
          {a.used_in.length > 0 && (
            <section className="card">
              <h2>Used to resolve</h2>
              <ul className="plain-list">{a.used_in.map((i) => <li key={i.ref}><Link to={`/incidents/${i.ref}`} className="mono small">{i.ref}</Link> {i.title}</li>)}</ul>
            </section>
          )}
          <AttachmentsPanel recordRef={a.ref} editable={writer && !a.synced_with_problem} canDelete={() => isManager(user)} />
          <HistoryPanel recordRef={a.ref} version={a} />
        </aside>
      </div>
      {editing && <ArticleModal article={a} onClose={() => setEditing(false)} onDone={(x) => { setData(x as Article); setEditing(false); }} />}
    </>
  );
}

function ArticleModal({ article, onClose, onDone }: { article?: Article; onClose: () => void; onDone: (a: ArticleRow) => void }) {
  const [form, setForm] = useState({
    title: article?.title ?? '', body: article?.body ?? '', article_type: article?.article_type ?? ('how_to' as ArticleType),
    audience: article?.audience ?? ('internal' as 'internal' | 'end_users'), review_by: article?.review_by ?? '',
  });
  // Pasting a screenshot uploads it; a failed upload shows here, a failed save in the modal's own error line.
  const [pasteError, setPasteError] = useState<string | null>(null);
  const submit = async () => {
    const body = { ...form, review_by: form.review_by || null };
    onDone(article ? await api.patch<Article>(`/api/articles/${article.ref}`, body) : await api.post<Article>('/api/articles', body));
  };
  return (
    <FormModal title={article ? `Edit ${article.ref}` : 'Write an article'} submitLabel={article ? 'Save' : 'Save draft'} onClose={onClose} onSubmit={submit}>
      <label className="full">Title<input required minLength={3} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What the reader wants to do or fix" /></label>
      <label>Type<select value={form.article_type} onChange={(e) => setForm({ ...form, article_type: e.target.value as ArticleType })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>Audience<select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as 'internal' })}><option value="internal">Internal (service desk, engineers)</option><option value="end_users">End users</option></select></label>
      <label className="full">Text
        <textarea rows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Steps, symptoms, cause… Markdown; paste formatted text or screenshots once the article is saved."
          {...richPaste(article?.ref ?? null, (v) => setForm((f) => ({ ...f, body: v })), setPasteError)} />
      </label>
      <label>Review by<input type="date" value={form.review_by} onChange={(e) => setForm({ ...form, review_by: e.target.value })} /></label>
      {pasteError && <div className="error full">{pasteError}</div>}
    </FormModal>
  );
}
