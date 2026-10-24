// Development work (#166): planning a sprint, changing it, and completing it with a choice per unfinished item.
import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { useApi } from '../../../hooks';
import type { Sprint, SprintRow, SprintStatus } from '../../../api/types/development';

const STATUS_LABEL: Record<SprintStatus, string> = { planned: 'Planned', active: 'Active', completed: 'Completed' };
const isoDay = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function SprintStatusTag({ status }: { status: SprintStatus }) {
  return <span className={`tag sp-status sp-status-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** A new sprint for a team (two weeks from today by default), or changes to one. */
export function SprintForm({ teamId, sprint, suggestedCapacity, count = 0, onClose, onDone }: {
  teamId?: number; sprint?: Sprint; suggestedCapacity?: number | null; count?: number; onClose: () => void; onDone: (id: number) => void;
}) {
  const [form, setForm] = useState({
    name: sprint?.name ?? `Sprint ${count + 1}`, goal: sprint?.goal ?? '', starts_on: sprint?.starts_on ?? isoDay(0), ends_on: sprint?.ends_on ?? isoDay(13),
    capacity: sprint?.capacity != null ? String(sprint.capacity) : suggestedCapacity ? String(suggestedCapacity) : '',
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const locked = sprint?.status === 'completed';
  const submit = async () => {
    const body = { name: form.name, goal: form.goal, ...(locked ? {} : { starts_on: form.starts_on, ends_on: form.ends_on, capacity: form.capacity ? Number(form.capacity) : null }) };
    const s = sprint ? await api.patch<Sprint>(`/api/sprints/${sprint.id}`, body) : await api.post<Sprint>('/api/sprints', { team_id: teamId, ...body });
    onDone(s.id);
  };
  return (
    <FormModal title={sprint ? `Change ${sprint.name}` : 'New sprint'} submitLabel={sprint ? 'Save' : 'Plan it'} onClose={onClose} onSubmit={submit}
      intro={!sprint && <p className="muted small">Two weeks is a good start. The capacity is how many points the team expects to finish{suggestedCapacity ? `; the last sprints averaged ${suggestedCapacity}` : ''}.</p>}>
      <label>Name<input required value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={100} /></label>
      <label>Capacity <span className="muted small">(points)</span><input type="number" min={1} max={999} value={form.capacity} disabled={locked} onChange={(e) => set('capacity', e.target.value)} /></label>
      <label>Starts<input type="date" required value={form.starts_on} disabled={locked} onChange={(e) => set('starts_on', e.target.value)} /></label>
      <label>Ends<input type="date" required value={form.ends_on} min={form.starts_on} disabled={locked} onChange={(e) => set('ends_on', e.target.value)} /></label>
      <label className="full">Sprint goal<textarea rows={2} value={form.goal} onChange={(e) => set('goal', e.target.value)} placeholder="What the team wants to have achieved when the sprint ends" /></label>
    </FormModal>
  );
}

/** Completing: each unfinished item goes back to the backlog (the default) or on to the next planned sprint. */
export function CompleteSprint({ sprint, onClose, onDone }: { sprint: Sprint; onClose: () => void; onDone: () => void }) {
  const unfinished = sprint.work_items.filter((w) => w.status !== 'done');
  const { data: planned } = useApi<SprintRow[]>(`/api/sprints?team=${sprint.team_id}&status=planned`);
  const next = planned?.slice().sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0] ?? null;
  const [choice, setChoice] = useState<Record<string, 'backlog' | 'next_sprint'>>({});
  const submit = async () => {
    await api.post(`/api/sprints/${sprint.id}/complete`, { unfinished: choice, ...(next ? { next_sprint_id: next.id } : {}) });
    onDone();
  };
  const done = sprint.work_items.length - unfinished.length;
  return (
    <FormModal title={`Complete ${sprint.name}`} submitLabel="Complete the sprint" onClose={onClose} onSubmit={submit}
      intro={<p className="muted small">{done} of {sprint.work_items.length} items done, {sprint.points.completed} of {sprint.points.scope} points. Done items stay with the sprint; choose where each unfinished one goes.</p>}>
      {unfinished.length === 0 && <p className="full">Everything is done.</p>}
      {unfinished.length > 0 && (
        <fieldset className="full sp-carry" aria-label="Unfinished items">
          {!next && <p className="muted small">No next sprint is planned, so unfinished items go back to the backlog. Plan the next sprint first to carry them over.</p>}
          {unfinished.map((w) => (
            <label key={w.ref} className="sp-carry-row">
              <span className="sp-carry-title"><span className="mono small">{w.ref}</span> {w.title}{w.points !== null && <span className="muted small"> · {w.points} pts</span>}</span>
              <select value={choice[w.ref] ?? 'backlog'} disabled={!next} onChange={(e) => setChoice({ ...choice, [w.ref]: e.target.value as 'backlog' | 'next_sprint' })} aria-label={`Where ${w.ref} goes`}>
                <option value="backlog">Back to the backlog</option>
                {next && <option value="next_sprint">On to {next.name}</option>}
              </select>
            </label>
          ))}
        </fieldset>
      )}
    </FormModal>
  );
}
