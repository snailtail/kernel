import { useState } from 'react';
import { api, type ProblemDetail } from '../../../api/client';
import { CommentBox } from '../../../components/CommentBox';
import { canEdit, useSession } from '../../../session';
import { ActivityLine } from '../../../components/History';

export function ActivitySection({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'comments'>('all');

  const submit = async (body: string) => {
    setError(null);
    try {
      onChange(await api.post<ProblemDetail>(`/api/problems/${p.ref}/comments`, { body }));
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const items = filter === 'comments' ? p.activity.filter((a) => a.kind === 'comment' || (a.kind === 'status' && a.body)) : p.activity;

  return (
    <section className="card">
      <div className="section-head">
        <h2>Work notes &amp; history</h2>
        <div className="toggle">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'comments' ? 'on' : ''} onClick={() => setFilter('comments')}>Notes</button>
        </div>
      </div>
      {canEdit(user) && (
        <CommentBox recordRef={p.ref} rows={3} placeholder="Add a work note: findings, analysis steps, decisions… Paste screenshots and logs here." error={error} onError={setError} onSubmit={submit} />
      )}
      <ul className="activity">
        {items.map((a) => <li key={a.id}><ActivityLine activity={a} /></li>)}
      </ul>
    </section>
  );
}
