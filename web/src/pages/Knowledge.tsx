import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { AttachmentsPanel } from '../components/Attachments';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { richPaste } from '../components/RichPaste';
import { formatDate, relativeTime } from '../format';
import { useApi, useOpenOnNew, useSearchText } from '../hooks';
import { canEdit, isManager, useSession } from '../session';

export interface ArticleRow {
  ref: string; title: string; article_type: ArticleType; audience: 'internal' | 'end_users'; status: 'draft' | 'published' | 'retired';
  owner: string | null; review_by: string | null; due_for_review: boolean; synced_with_problem: boolean; problem_ref: string | null;
  helpful: number; not_helpful: number; used_count: number; updated_at: string;
}
type ArticleType = 'how_to' | 'troubleshooting' | 'known_error' | 'faq';
interface Article extends ArticleRow {
  body: string; owner_id: number | null; problem_status: string | null; source_incident_ref: string | null; published_at: string | null;
  cis: { ref: string; name: string }[]; my_feedback: boolean | null; used_in: { ref: string; title: string; used_at: string }[];
  activity: { id: number; kind: string; body: string; created_at: string; user_name: string | null; data: any }[];
}

export const TYPE_LABEL: Record<ArticleType, string> = { how_to: 'How-to', troubleshooting: 'Troubleshooting', known_error: 'Known error', faq: 'FAQ' };
const STATUS_CLASS: Record<string, string> = { draft: 'status-new', published: 'status-resolved', retired: 'status-closed' };

export function ArticleStatus({ status }: { status: string }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? ''}`}>{status}</span>;
}

export function KnowledgePage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useSearchText({ trim: true });
  const [creating, setCreating] = useState(false);
  useOpenOnNew(() => setCreating(true));
  const navigate = useNavigate();
  const set = (k: string, v: string) => setParams((prev) => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const { data, loading } = useApi<ArticleRow[]>(`/api/articles?${params}`);
  const writer = canEdit(user);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Knowledge</h1>
          <p className="muted">Workarounds and solutions people can find when they need them. Known errors publish here in one step.</p>
        </div>
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
      </div>
      <section className={`card flush ${loading ? 'is-loading' : ''}`}>
        {data?.length === 0 ? (
          <p className="empty">{params.get('q') ? 'No articles match.' : 'No articles yet. Publish a known error from its problem, or write one here.'}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Ref</th><th>Title</th><th>Type</th><th>Status</th><th className="hide-sm">Audience</th><th className="hide-sm">Used</th><th className="hide-sm">Helpful</th><th className="hide-sm">Updated</th></tr></thead>
              <tbody>
                {data?.map((a) => (
                  <tr key={a.ref}>
                    <td className="mono nowrap"><Link to={`/knowledge/${a.ref}`}>{a.ref}</Link></td>
                    <td className="title-cell"><Link to={`/knowledge/${a.ref}`}>{a.title}</Link>{a.due_for_review && <span className="badge warn-badge" title={`Review was due ${a.review_by}`}>review</span>}</td>
                    <td className="muted">{TYPE_LABEL[a.article_type]}</td>
                    <td><ArticleStatus status={a.status} /></td>
                    <td className="hide-sm muted">{a.audience === 'end_users' ? 'End users' : 'Internal'}</td>
                    <td className="hide-sm">{a.used_count || '–'}</td>
                    <td className="hide-sm">{a.helpful + a.not_helpful ? `${Math.round((a.helpful / (a.helpful + a.not_helpful)) * 100)}%` : '–'}</td>
                    <td className="hide-sm muted nowrap">{relativeTime(a.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && <ArticleModal onClose={() => setCreating(false)} onDone={(a) => navigate(`/knowledge/${a.ref}`)} />}
    </>
  );
}

export function ArticlePage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: a, setData, error } = useApi<Article>(`/api/articles/${ref}`);
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ciRef, setCiRef] = useState('');
  if (error) return <div className="error">{error}</div>;
  if (!a) return null;
  const writer = canEdit(user);
  const run = async (fn: () => Promise<Article>) => {
    setActionError(null);
    try {
      setData(await fn());
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
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
            {a.status === 'draft' && !canPublish && <span className="muted small">A problem manager publishes articles for end users.</span>}
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
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...form, review_by: form.review_by || null };
    try {
      onDone(article ? await api.patch<Article>(`/api/articles/${article.ref}`, body) : await api.post<Article>('/api/articles', body));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={article ? `Edit ${article.ref}` : 'Write an article'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="full">Title<input required minLength={3} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What the reader wants to do or fix" /></label>
        <label>Type<select value={form.article_type} onChange={(e) => setForm({ ...form, article_type: e.target.value as ArticleType })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Audience<select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as 'internal' })}><option value="internal">Internal (service desk, engineers)</option><option value="end_users">End users</option></select></label>
        <label className="full">Text
          <textarea rows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Steps, symptoms, cause… Markdown; paste formatted text or screenshots once the article is saved."
            {...richPaste(article?.ref ?? null, (v) => setForm((f) => ({ ...f, body: v })), setError)} />
        </label>
        <label>Review by<input type="date" value={form.review_by} onChange={(e) => setForm({ ...form, review_by: e.target.value })} /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{article ? 'Save' : 'Save draft'}</button></div>
      </form>
    </Modal>
  );
}

/** Knowledge on an incident: suggested articles while it is open, the ones used, and a draft from its resolution. */
export function IncidentKnowledgePanel({ incident: i, editable, onChange }: {
  incident: { ref: string; status: string; resolution: string; suggested_articles?: ArticleRow[]; articles_used?: { ref: string; title: string }[] };
  editable: boolean; onChange: () => void;
}) {
  const { user } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const suggested = i.suggested_articles ?? [];
  const used = i.articles_used ?? [];
  if (!suggested.length && !used.length && !(i.resolution && canEdit(user))) return null;
  const use = async (ref: string) => {
    try {
      await api.post(`/api/incidents/${i.ref}/articles-used`, { article: ref });
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Knowledge</h2>
      {used.length > 0 && (
        <>
          <div className="muted small">Used to resolve</div>
          <ul className="plain-list">{used.map((a) => <li key={a.ref}><Link to={`/knowledge/${a.ref}`}>{a.title}</Link></li>)}</ul>
        </>
      )}
      {suggested.length > 0 && (
        <>
          <div className="muted small">Might help</div>
          <ul className="plain-list">
            {suggested.map((a) => (
              <li key={a.ref} className="affected">
                <Link to={`/knowledge/${a.ref}`}>{a.title}</Link>
                <span className="muted small">{TYPE_LABEL[a.article_type]}</span>
                {editable && <button className="btn small" onClick={() => use(a.ref)} title="Record that this article resolved the incident">Used this</button>}
              </li>
            ))}
          </ul>
        </>
      )}
      {i.resolution && canEdit(user) && ['resolved', 'closed'].includes(i.status) && (
        <button className="btn small" onClick={async () => { const a = await api.post<{ ref: string }>(`/api/incidents/${i.ref}/article`, {}).catch((err) => { setError(err.message); return null; }); if (a) navigate(`/knowledge/${a.ref}`); }}>
          Reusable? Draft an article
        </button>
      )}
      {error && <div className="error small">{error}</div>}
    </section>
  );
}

/** Live suggestions in the "log an incident" form, from the title and CIs typed so far. */
export function ArticleSuggestions({ text, cis }: { text: string; cis: string }) {
  const [hits, setHits] = useState<ArticleRow[]>([]);
  useEffect(() => {
    if (text.trim().length < 4 && !cis.trim()) return setHits([]);
    const t = setTimeout(() => api.get<ArticleRow[]>(`/api/knowledge/suggest?${new URLSearchParams({ text, cis: cis.split(/[\s,]+/).filter(Boolean).join(','), limit: '3' })}`).then(setHits, () => setHits([])), 350);
    return () => clearTimeout(t);
  }, [text, cis]);
  if (!hits.length) return null;
  return (
    <div className="full hint-box kb-suggest">
      <strong>Known solutions</strong> – check these before logging:
      <ul className="plain-list">{hits.map((a) => <li key={a.ref}><a href={`/knowledge/${a.ref}`} target="_blank" rel="noreferrer">{a.title}</a> <span className="muted small">{TYPE_LABEL[a.article_type]}</span></li>)}</ul>
    </div>
  );
}
