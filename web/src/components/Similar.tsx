import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type ProblemDetail, type Status } from '../api';
import { StatusBadge } from './Badges';

interface Similar { ref: string; title: string; status: Status; priority: number; affected_service: string; workaround: string; score: number }

/** Live list of problems similar to a text; optionally lets a manager mark `duplicateRef` as a duplicate of one. */
export function SimilarProblems({ text, exclude, title = 'Similar problems', duplicateRef, empty }: { text: string; exclude?: string; title?: string; duplicateRef?: string; empty?: string }) {
  const [items, setItems] = useState<Similar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (text.trim().length < 4) {
      setItems(null);
      return;
    }
    const t = setTimeout(() => {
      api.get<Similar[]>(`/api/problems/similar?${new URLSearchParams({ text, ...(exclude ? { exclude } : {}) })}`).then(setItems, () => setItems(null));
    }, 350);
    return () => clearTimeout(t);
  }, [text, exclude]);

  const markDuplicate = async (of: string) => {
    if (!duplicateRef || !confirm(`Close ${duplicateRef} as a duplicate of ${of}? Its incidents and events are linked to ${of}.`)) return;
    try {
      const original = await api.post<ProblemDetail>(`/api/problems/${duplicateRef}/duplicate`, { of });
      navigate(`/problems/${original.ref}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!items || (!items.length && !empty)) return null;
  return (
    <section className="card similar">
      <h2>{title}</h2>
      {items.length === 0 && <p className="empty">{empty}</p>}
      {error && <div className="error">{error}</div>}
      <ul>
        {items.map((s) => (
          <li key={s.ref}>
            <div className="similar-head">
              <Link to={`/problems/${s.ref}`} className="mono">{s.ref}</Link>
              <StatusBadge kind="problem" status={s.status} />
            </div>
            <Link to={`/problems/${s.ref}`} className="similar-title">{s.title}</Link>
            {s.status === 'known_error' && s.workaround && <div className="similar-workaround"><strong>Workaround:</strong> {s.workaround}</div>}
            {duplicateRef && s.status !== 'closed' && (
              <button className="btn-link small" onClick={() => markDuplicate(s.ref)}>Close {duplicateRef} as duplicate of this</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
