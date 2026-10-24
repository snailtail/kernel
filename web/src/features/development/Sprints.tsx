// Development work (#166): a team's sprints, the active one first, then the planned and the completed ones.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatDay } from '../../format';
import { useApi } from '../../hooks';
import { useLive } from '../../hooks/useLive';
import { canEdit, useSession } from '../../session';
import type { SprintRow } from '../../api/types/development';
import { useTeamParam } from './common';
import { SprintForm, SprintStatusTag } from './components/SprintForms';

export function SprintsPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const { team, teams, picker } = useTeamParam();
  const { data, refresh } = useApi<SprintRow[]>(team ? `/api/sprints?team=${team}` : null);
  useLive(['work_item:*'], refresh);
  const [creating, setCreating] = useState(false);
  const editable = canEdit(user);
  const completed = (data ?? []).filter((s) => s.status === 'completed');
  const velocity = completed.length ? Math.round(completed.slice(0, 6).reduce((a, s) => a + s.points.completed, 0) / Math.min(completed.length, 6)) : null;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Sprints</h1>
          <p className="muted">Short, fixed stretches with a goal: plan what the team can finish, work it on the board, then look back.</p>
        </div>
        {editable && team && <button className="btn primary page-new" onClick={() => setCreating(true)}>New sprint</button>}
      </header>
      <div className="filters">{picker}{velocity !== null && <span className="muted small">Velocity: {velocity} points per sprint (last {Math.min(completed.length, 6)})</span>}</div>
      {teams && !teams.some((t) => t.active) && <p className="placeholder">Sprints belong to a team. Create a team first.</p>}
      {data && data.length === 0 && <p className="placeholder">No sprints yet.{editable ? ' Plan the first one: give it a goal and two weeks, then pull items from the top of the backlog.' : ''}</p>}
      {data && data.length > 0 && (
        <ul className="sp-list">
          {data.map((s) => (
            <li key={s.id} className="card sp-row">
              <div className="sp-row-main">
                <Link to={`/sprints/${s.id}`} className="wi-title">{s.name}</Link> <SprintStatusTag status={s.status} />
                <div className="muted small">{formatDay(s.starts_on)} – {formatDay(s.ends_on)}{s.goal && <> · {s.goal}</>}</div>
              </div>
              <div className="sp-row-numbers small">
                {s.status === 'completed'
                  ? <span><strong>{s.points.completed}</strong> of {s.points.committed} committed points done</span>
                  : <span className={s.over_capacity ? 'warn' : ''}><strong>{s.points.scope}</strong>{s.capacity ? ` / ${s.capacity}` : ''} points · {s.items.done} of {s.items.total} done</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && team && (
        <SprintForm teamId={Number(team)} suggestedCapacity={velocity} count={(data ?? []).length} onClose={() => setCreating(false)} onDone={(id) => navigate(`/sprints/${id}`)} />
      )}
    </>
  );
}
