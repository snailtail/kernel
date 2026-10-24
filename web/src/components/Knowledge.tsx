import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api';
import { canEdit, useSession } from '../session';

export interface ArticleRow {
  ref: string; title: string; article_type: ArticleType; audience: 'internal' | 'end_users'; status: 'draft' | 'published' | 'retired';
  owner: string | null; review_by: string | null; due_for_review: boolean; synced_with_problem: boolean; problem_ref: string | null;
  helpful: number; not_helpful: number; used_count: number; updated_at: string;
}
export type ArticleType = 'how_to' | 'troubleshooting' | 'known_error' | 'faq';
export const TYPE_LABEL: Record<ArticleType, string> = { how_to: 'How-to', troubleshooting: 'Troubleshooting', known_error: 'Known error', faq: 'FAQ' };

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
