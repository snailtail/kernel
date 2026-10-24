import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../session';
import { OnCallLine } from './OnCall';
import type { Team } from '../api/types/teams';

let cache: { at: number; teams: Team[] } | null = null;
/** Teams for selects and labels, shared between pages for a minute. */
export function useTeams() {
  const [teams, setTeams] = useState<Team[]>(cache?.teams ?? []);
  useEffect(() => {
    if (cache && Date.now() - cache.at < 60_000) return;
    api.get<Team[]>('/api/teams').then((t) => { cache = { at: Date.now(), teams: t }; setTeams(t); }, () => {});
  }, []);
  return teams;
}
export const forgetTeams = () => { cache = null; };

/** Team select plus an assignee select that lists the team's members first. */
export function TeamAndAssignee({ teamId, assigneeId, onTeam, onAssignee, disabled }: { teamId: number | null; assigneeId: number | null; onTeam: (id: number | null) => void; onAssignee: (id: number | null) => void; disabled?: boolean }) {
  const { meta } = useSession();
  const teams = useTeams();
  const team = teams.find((t) => t.id === teamId);
  const memberIds = new Set(team?.members.map((m) => m.user_id) ?? []);
  const inTeam = meta.assignees.filter((a) => memberIds.has(a.id));
  const others = meta.assignees.filter((a) => !memberIds.has(a.id));
  return (
    <>
      <dt>Team</dt>
      <dd>
        <select value={teamId ?? ''} disabled={disabled} onChange={(e) => onTeam(e.target.value ? Number(e.target.value) : null)} aria-label="Team">
          <option value="">–</option>
          {teams.filter((t) => t.active || t.id === teamId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <OnCallLine teamId={teamId} />
      </dd>
      <dt>Assignee</dt>
      <dd>
        <select value={assigneeId ?? ''} disabled={disabled} onChange={(e) => onAssignee(e.target.value ? Number(e.target.value) : null)} aria-label="Assignee">
          <option value="">{team ? '– (team queue)' : '–'}</option>
          {inTeam.length > 0 && <optgroup label={team!.name}>{inTeam.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</optgroup>}
          {(!team || !team.members.length) && others.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
        </select>
      </dd>
    </>
  );
}
