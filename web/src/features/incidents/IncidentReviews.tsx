// All post-incident reviews (#120): what is due (overdue first), what was published and what was waived, by owner
// and team. The view the weekly incident or problem meeting needs.
import { Link } from 'react-router';
import { useApi, useListParams } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { useSession } from '../../session';
import { useTeams } from '../../components/Teams';
import { formatDate, relativeTime } from '../../format';
import type { ReviewRow } from '../../api/types/reviews';

const TABS = [['due', 'Due'], ['published', 'Published'], ['waived', 'Waived']] as const;

export function IncidentReviewsPage() {
  const teams = useTeams();
  const { meta } = useSession();
  const { params, set } = useListParams();
  const tab = params.get('tab') ?? 'due';
  const { data, loading, refresh } = useApi<ReviewRow[]>(`/api/incident-reviews?${params}`);
  useLive(['incident:*'], refresh);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Post-incident reviews</h1>
          <p className="muted">Short, blameless look-backs on major incidents: contributing factors become problems, follow-ups become actions.</p>
        </div>
      </header>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => set('tab', k === 'due' ? '' : k)}>{label}</button>)}
      </div>
      <div className="filters">
        <select value={params.get('owner') ?? ''} onChange={(e) => set('owner', e.target.value)} aria-label="Owner">
          <option value="">Any owner</option><option value="me">Mine</option>
          {meta.assignees.filter((a) => a.role !== 'viewer').map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
        </select>
        {teams.length > 0 && (
          <select value={params.get('team') ?? ''} onChange={(e) => set('team', e.target.value)} aria-label="Team">
            <option value="">Any team</option><option value="mine">My teams</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
      </div>
      <section className={`card flush ${loading ? 'is-loading' : ''}`}>
        {data?.length === 0 ? <p className="empty">{tab === 'due' ? 'No reviews are due.' : tab === 'published' ? 'No published reviews yet.' : 'No waived reviews.'}</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Incident</th><th>Owner</th><th>{tab === 'published' ? 'Published' : 'Due'}</th><th className="hide-sm">Team</th><th className="hide-sm" title="Contributing factors that became problems">Factors → problems</th><th className="hide-sm" title="Follow-ups that became actions">Follow-ups → actions</th></tr></thead>
              <tbody>
                {data?.map((r) => (
                  <tr key={r.ref}>
                    <td className="title-cell"><Link to={`/incidents/${r.incident_ref}/review`} className="mono">{r.incident_ref}</Link> <Link to={`/incidents/${r.incident_ref}/review`}>{r.title}</Link> {r.is_major && <span className="badge major">Major</span>}</td>
                    <td className="muted">{r.owner ?? '–'}</td>
                    <td className="nowrap">
                      {tab === 'published' ? (r.published_at ? <span title={formatDate(r.published_at)}>{relativeTime(r.published_at)}</span> : '–')
                        : <>{r.due ?? '–'}{r.overdue ? <span className="badge overdue">Overdue</span> : <span className="muted small"> {r.status}</span>}</>}
                    </td>
                    <td className="hide-sm muted">{r.team ?? '–'}</td>
                    <td className="hide-sm">{r.factors ? `${r.factors_to_problems} of ${r.factors}` : '–'}</td>
                    <td className="hide-sm">{r.follow_ups ? `${r.follow_ups_to_actions} of ${r.follow_ups}` : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
