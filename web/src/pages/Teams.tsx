import { OnCallLine, PagingCard } from '../components/OnCall';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { PriorityBadge } from '../components/Badges';
import { Modal } from '../components/Modal';
import { relativeTime } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

export interface Team {
  id: number; name: string; description: string; email: string; auto_assign: 'none' | 'round_robin'; active: boolean;
  members: { user_id: number; name: string; role: 'lead' | 'member' }[]; supports: { ref: string; name: string }[];
  open_incidents: number; unassigned: number; mine: boolean;
}
interface QueueRow { ref: string; title: string; status: string; priority: number; assignee: string | null; created_at: string; at_risk: boolean }
interface RequestTaskRow { ref: string; title: string; task_id: number; task: string; assignee: string | null; opened_at: string; at_risk: boolean }
interface Queue { team: { id: number; name: string }; unassigned: QueueRow[]; mine: QueueRow[]; at_risk: QueueRow[]; all: QueueRow[]; request_tasks?: RequestTaskRow[] }

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

export function TeamsPage() {
  const { user } = useSession();
  const { data: teams, reload } = useApi<Team[]>('/api/teams');
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [members, setMembers] = useState<Team | null>(null);
  const admin = user.role === 'admin';
  const current = teams?.find((t) => t.id === selected) ?? teams?.find((t) => t.mine) ?? teams?.[0];
  const done = () => { forgetTeams(); reload(); };
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Teams</h1>
          <p className="muted">Where work lands: each team has a queue, members and the services it supports. New incidents on those services go to the team.</p>
        </div>
        <div className="head-actions">{admin && <button className="btn primary" onClick={() => setEditing('new')}>Add team</button>}</div>
      </header>
      {teams?.length === 0 ? (
        <section className="card"><p className="empty">No teams yet. {admin ? 'Add the service desk and the support teams, then say which services each one supports.' : 'An administrator sets them up.'}</p></section>
      ) : (
        <div className="teams-layout">
          <section className="card flush team-list">
            <ul className="plain-list">
              {teams?.map((t) => (
                <li key={t.id}>
                  <button type="button" className={`team-item ${current?.id === t.id ? 'on' : ''}`} onClick={() => setSelected(t.id)}>
                    <span className="team-name">{t.name}{!t.active && <span className="muted small"> (inactive)</span>}{t.mine && <span className="badge">my team</span>}</span>
                    <span className="muted small">{t.open_incidents} open{t.unassigned ? ` · ${t.unassigned} unassigned` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {current && (
            <TeamDetail key={current.id} team={current} canEdit={admin} canMembers={admin || current.members.some((m) => m.user_id === user.id && m.role === 'lead')} onEdit={() => setEditing(current)} onMembers={() => setMembers(current)} />
          )}
        </div>
      )}
      {editing && <TeamModal team={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); done(); }} />}
      {members && <MembersModal team={members} onClose={() => setMembers(null)} onDone={() => { setMembers(null); done(); }} />}
    </>
  );
}

function TeamDetail({ team: t, canEdit, canMembers, onEdit, onMembers }: { team: Team; canEdit: boolean; canMembers: boolean; onEdit: () => void; onMembers: () => void }) {
  const { data: q } = useApi<Queue>(`/api/teams/${t.id}/queue`);
  const [tab, setTab] = useState<'unassigned' | 'mine' | 'at_risk' | 'all'>('unassigned');
  const rows = q?.[tab] ?? [];
  return (
    <div className="team-detail">
      <section className="card">
        <div className="section-head">
          <h2>{t.name}</h2>
          <span className="section-actions">
            {canMembers && <button className="btn-link" onClick={onMembers}>Members</button>}
            {canEdit && <button className="btn-link" onClick={onEdit}>Edit</button>}
          </span>
        </div>
        {t.description && <p className="muted">{t.description}</p>}
        <dl className="kv details">
          <dt>Members</dt>
          <dd>{t.members.length ? t.members.map((m) => `${m.name}${m.role === 'lead' ? ' (lead)' : ''}`).join(', ') : 'None yet'}</dd>
          <dt>Supports</dt>
          <dd>{t.supports.length ? t.supports.map((c, n) => <span key={c.ref}>{n > 0 && ', '}<Link to={`/cis/${c.ref}`}>{c.name}</Link></span>) : '–'}</dd>
          <dt>New work</dt><dd>{t.auto_assign === 'round_robin' ? 'Assigned in turn to the member with the least open work' : 'Waits in the queue until someone takes it'}</dd>
          {t.email && <><dt>Email</dt><dd>{t.email}</dd></>}
        </dl>
      </section>
      <PagingCard team={t} />
      <section className="card flush">
        <div className="tabs queue-tabs" role="tablist">
          {(['unassigned', 'mine', 'at_risk', 'all'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {{ unassigned: 'Unassigned', mine: 'Assigned to me', at_risk: 'At risk', all: 'All open' }[k]} <span className="count">{q?.[k].length ?? 0}</span>
            </button>
          ))}
        </div>
        {rows.length === 0 ? <p className="empty">{tab === 'unassigned' ? 'Nothing waiting. 🎉' : 'Nothing here.'}</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Ref</th><th>Title</th><th>Priority</th><th className="hide-sm">Assignee</th><th className="hide-sm">Opened</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ref} className={r.at_risk ? 'row-risk' : ''}>
                    <td className="mono nowrap"><Link to={`/incidents/${r.ref}`}>{r.ref}</Link></td>
                    <td className="title-cell"><Link to={`/incidents/${r.ref}`}>{r.title}</Link></td>
                    <td><PriorityBadge priority={r.priority} /></td>
                    <td className="hide-sm muted">{r.assignee ?? '–'}</td>
                    <td className="hide-sm muted nowrap">{relativeTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {!!q?.request_tasks?.length && (
        <section className="card flush">
          <h2 className="card-pad">Service request tasks <span className="count">{q.request_tasks.length}</span></h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Ref</th><th>Task</th><th className="hide-sm">Assignee</th><th className="hide-sm">Open since</th></tr></thead>
              <tbody>
                {q.request_tasks.map((r) => (
                  <tr key={r.task_id} className={r.at_risk ? 'row-risk' : ''}>
                    <td className="mono nowrap"><Link to={`/requests/${r.ref}`}>{r.ref}</Link></td>
                    <td className="title-cell"><Link to={`/requests/${r.ref}`}>{r.task}</Link><div className="muted small">{r.title}</div></td>
                    <td className="hide-sm muted">{r.assignee ?? '–'}</td>
                    <td className="hide-sm muted nowrap">{relativeTime(r.opened_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function TeamModal({ team, onClose, onDone }: { team?: Team; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    name: team?.name ?? '', description: team?.description ?? '', email: team?.email ?? '', auto_assign: team?.auto_assign ?? ('none' as Team['auto_assign']),
    active: team?.active ?? true, cis: (team?.supports ?? []).map((c) => c.ref).join(', '),
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...form, cis: form.cis.split(/[\s,]+/).filter(Boolean) };
    try {
      if (team) await api.put(`/api/teams/${team.id}`, body);
      else await api.post('/api/teams', body);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!team || !window.confirm(`Remove the team ${team.name}?`)) return;
    try {
      await api.del(`/api/teams/${team.id}`);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={team ? `Edit ${team.name}` : 'Add a team'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Name<input required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Service desk, Network, DBA" /></label>
        <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label className="full">What the team does<textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label className="full">Supports <span className="muted small">(services and CIs, e.g. SVC000003 CI000012 – their new incidents go to this team)</span><input value={form.cis} onChange={(e) => setForm({ ...form, cis: e.target.value })} /></label>
        <label>New work<select value={form.auto_assign} onChange={(e) => setForm({ ...form, auto_assign: e.target.value as Team['auto_assign'] })}><option value="none">Waits in the queue</option><option value="round_robin">Assigned in turn (round robin)</option></select></label>
        {team && <label className="check"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>}
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          {team && <button type="button" className="btn danger" onClick={remove}>Remove</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function MembersModal({ team, onClose, onDone }: { team: Team; onClose: () => void; onDone: () => void }) {
  const { meta } = useSession();
  const [members, setMembers] = useState(team.members.map((m) => ({ user_id: m.user_id, role: m.role })));
  const [error, setError] = useState<string | null>(null);
  const role = (id: number) => members.find((m) => m.user_id === id)?.role ?? '';
  const set = (id: number, r: '' | 'lead' | 'member') => setMembers((cur) => (r ? [...cur.filter((m) => m.user_id !== id), { user_id: id, role: r }] : cur.filter((m) => m.user_id !== id)));
  const save = async () => {
    try {
      await api.put(`/api/teams/${team.id}/members`, { members });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={`Members of ${team.name}`} onClose={onClose}>
      <div className="members-list">
        {meta.assignees.map((u) => (
          <label key={u.id} className="member-row">
            <span>{u.display_name}</span>
            <select value={role(u.id)} onChange={(e) => set(u.id, e.target.value as '' | 'lead' | 'member')} aria-label={`Role of ${u.display_name}`}>
              <option value="">Not a member</option><option value="member">Member</option><option value="lead">Lead</option>
            </select>
          </label>
        ))}
      </div>
      <p className="muted small">Leads can change their team's members and are told when an SLA is at risk with no one assigned.</p>
      {error && <div className="error">{error}</div>}
      <div className="actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div>
    </Modal>
  );
}

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
