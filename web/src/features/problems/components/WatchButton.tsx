import { api, type ProblemDetail } from '../../../api/client';
import { useSession } from '../../../session';

export function WatchButton({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  const watching = p.watchers.some((w) => w.id === user.id);
  const others = p.watchers.filter((w) => w.id !== user.id).map((w) => w.display_name);
  const toggle = async () => onChange(await (watching ? api.del<ProblemDetail>(`/api/problems/${p.ref}/watch`) : api.put<ProblemDetail>(`/api/problems/${p.ref}/watch`, {})));
  return (
    <button className={`btn-link watch ${watching ? 'on' : ''}`} onClick={toggle} title={p.watchers.length ? `Watching: ${p.watchers.map((w) => w.display_name).join(', ')}` : 'Nobody is watching'}>
      {watching ? '★ Watching' : '☆ Watch'}{others.length > 0 && <span className="muted"> · {others.length + (watching ? 1 : 0)}</span>}
    </button>
  );
}
