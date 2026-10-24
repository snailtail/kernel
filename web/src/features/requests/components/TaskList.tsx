import { Link } from 'react-router';
import { api } from '../../../api/client';
import { askText } from '../../../components/Ask';
import { relativeTime } from '../../../format';
import { useSession } from '../../../session';
import type { RequestDetail, Task } from '../../../api/types/requests';

export function TaskList({ r, onRun }: { r: RequestDetail; onRun: (fn: () => Promise<RequestDetail>) => Promise<boolean> }) {
  const { user } = useSession();
  if (!r.tasks.length) {
    return <p className="placeholder">{r.status === 'awaiting_approval' ? 'The tasks start when the request is approved.' : 'No tasks.'}</p>;
  }
  const done = async (t: Task) => {
    const note = await askText(`Done: ${t.title}`, 'Note (optional)', { confirmLabel: 'Mark done', message: 'What was done, for the next person and the history.' });
    if (note === null) return;
    await onRun(() => api.post(`/api/requests/${r.ref}/tasks/${t.id}/complete`, { note }));
  };
  return (
    <ol className="task-steps">
      {r.tasks.map((t) => (
        <li key={t.id} className={`task-step ${t.status}`}>
          <div className="task-step-head">
            <strong>{t.title}</strong>
            <span className={`tag task-${t.status}`}>{t.status === 'pending' ? 'Waiting' : t.status === 'open' ? 'Open' : t.status === 'done' ? 'Done' : 'Cancelled'}</span>
          </div>
          <div className="muted small">
            {t.kind === 'change' && <>{t.change_ref ? <Link to={`/changes/${t.change_ref}`} className="mono">{t.change_ref}</Link> : 'Standard change'} · </>}
            {t.kind === 'webhook' && <>Automatic{t.webhook ? ` (${t.webhook})` : ''} · </>}
            {t.team ?? 'Anyone'}{t.assignee ? ` · ${t.assignee}` : ''}
            {t.done_at && ` · done ${relativeTime(t.done_at)}${t.done_by ? ` by ${t.done_by}` : ''}`}
          </div>
          {t.note && <p className="small">{t.note}</p>}
          {t.status === 'open' && t.by_change && <p className="muted small">Recording the outcome on {t.change_ref} completes this task.</p>}
          {t.status === 'open' && t.may_complete && (
            <div className="actions">
              {t.assignee_id !== user.id && <button className="btn small" onClick={() => onRun(() => api.patch(`/api/requests/${r.ref}/tasks/${t.id}`, { assignee_id: user.id }))}>Take it</button>}
              <button className="btn small primary" onClick={() => done(t)}>Mark done</button>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
