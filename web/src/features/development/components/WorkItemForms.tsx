import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import type { Team } from '../../../api/types/teams';
import type { WorkItem, WorkItemRow, WorkItemType } from '../../../api/types/development';
import { POINTS, TYPE_LABEL, TYPES, useParentTypes } from '../common';

const labelsOf = (text: string) => [...new Set(text.split(',').map((l) => l.trim()).filter(Boolean))];

/** The parents an item of this type can have, from the open backlog. */
function ParentSelect({ type, value, self, onChange }: { type: WorkItemType; value: string; self?: string; onChange: (v: string) => void }) {
  const allowed = useParentTypes()[type];
  const { data } = useApi<WorkItemRow[]>(allowed.length ? `/api/work-items?status=open&limit=500&sort=updated` : null);
  if (!allowed.length) return null;
  const options = (data ?? []).filter((w) => allowed.includes(w.item_type) && w.ref !== self);
  return (
    <label>Under <span className="muted small">({allowed.map((t) => TYPE_LABEL[t].toLowerCase()).join(' or ')})</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Nothing</option>
        {value && !options.some((o) => o.ref === value) && <option value={value}>{value}</option>}
        {options.map((o) => <option key={o.ref} value={o.ref}>{o.ref} {o.title}</option>)}
      </select>
    </label>
  );
}

function TeamSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: teams } = useApi<Team[]>('/api/teams');
  return (
    <label>Team's backlog
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No team</option>{(teams ?? []).filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
  );
}

function BugFields({ form, set }: { form: Record<string, string>; set: (k: string, v: string) => void }) {
  return (
    <>
      <label className="full">Steps to reproduce<textarea rows={3} value={form.steps_to_reproduce} onChange={(e) => set('steps_to_reproduce', e.target.value)} placeholder={'1. Sign in\n2. Open the report'} /></label>
      <label>Expected<textarea rows={2} value={form.expected_result} onChange={(e) => set('expected_result', e.target.value)} /></label>
      <label>What happened<textarea rows={2} value={form.actual_result} onChange={(e) => set('actual_result', e.target.value)} /></label>
      <label className="full">Found in <span className="muted small">(version, browser, environment)</span><input value={form.found_in} onChange={(e) => set('found_in', e.target.value)} /></label>
    </>
  );
}

export function NewWorkItem({ team, parent, onClose, onDone }: { team?: string; parent?: { ref: string; type: WorkItemType }; onClose: () => void; onDone: (ref: string) => void }) {
  const childType: WorkItemType = parent?.type === 'epic' ? 'story' : parent ? 'task' : 'story';
  const [form, setForm] = useState<Record<string, string>>({
    type: childType, title: '', description: '', points: '', team_id: team && team !== 'none' ? team : '', parent: parent?.ref ?? '', labels: '',
    steps_to_reproduce: '', expected_result: '', actual_result: '', found_in: '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v, ...(k === 'type' && !parent ? { parent: '' } : {}) }));
  const type = form.type as WorkItemType;
  const parentTypes = useParentTypes();
  const submit = async () => {
    const w = await api.post<WorkItem>('/api/work-items', {
      type, title: form.title, description: form.description, labels: labelsOf(form.labels),
      ...(form.points ? { points: Number(form.points) } : {}), ...(form.team_id ? { team_id: Number(form.team_id) } : {}), ...(form.parent ? { parent: form.parent } : {}),
      ...(type === 'bug' ? { steps_to_reproduce: form.steps_to_reproduce, expected_result: form.expected_result, actual_result: form.actual_result, found_in: form.found_in } : {}),
    });
    onDone(w.ref);
  };
  return (
    <FormModal title={parent ? `New item under ${parent.ref}` : 'New work item'} submitLabel="Add to the backlog" onClose={onClose} onSubmit={submit}>
      <label>Type
        <select value={form.type} onChange={(e) => set('type', e.target.value)}>
          {TYPES.filter((t) => !parent || parentTypes[t].includes(parent.type)).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </label>
      <label>Story points
        <select value={form.points} onChange={(e) => set('points', e.target.value)}><option value="">Not estimated</option>{POINTS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
      </label>
      <label className="full">Title<input required autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder={type === 'bug' ? 'e.g. Export fails for reports over 10 MB' : type === 'epic' ? 'e.g. Self-service password reset' : 'e.g. As an analyst I can export the list to CSV'} /></label>
      {type === 'bug' ? <BugFields form={form} set={set} /> : <label className="full">Description <span className="muted small">(Markdown)</span><textarea rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder={type === 'task' ? '' : 'Who needs it, what they need, and why.'} /></label>}
      {!parent && <TeamSelect value={form.team_id} onChange={(v) => set('team_id', v)} />}
      {!parent && <ParentSelect type={type} value={form.parent} onChange={(v) => set('parent', v)} />}
      <label className="full">Labels <span className="muted small">(comma-separated)</span><input value={form.labels} onChange={(e) => set('labels', e.target.value)} /></label>
    </FormModal>
  );
}

export function EditWorkItem({ w, onClose, onDone }: { w: WorkItem; onClose: () => void; onDone: (w: WorkItem) => void }) {
  const { meta } = useSession();
  const masked = !!w.confidential_masked;
  const [form, setForm] = useState<Record<string, string>>({
    type: w.item_type, title: w.title, description: w.description ?? '', points: w.points ? String(w.points) : '', team_id: w.team_id ? String(w.team_id) : '',
    assignee_id: w.assignee_id ? String(w.assignee_id) : '', parent: w.parent?.ref ?? '', labels: w.labels.join(', '),
    steps_to_reproduce: w.steps_to_reproduce ?? '', expected_result: w.expected_result ?? '', actual_result: w.actual_result ?? '', found_in: w.found_in ?? '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const type = form.type as WorkItemType;
  const submit = async () => {
    onDone(await api.patch<WorkItem>(`/api/work-items/${w.ref}`, {
      labels: labelsOf(form.labels),
      // A mirrored item's own fields change in its source (#168).
      ...(w.mirror ? {} : {
        type, title: form.title, points: form.points ? Number(form.points) : null,
        team_id: form.team_id ? Number(form.team_id) : null, assignee_id: form.assignee_id ? Number(form.assignee_id) : null, parent: form.parent || null,
      }),
      // A confidential item's text is only sent by people who may read it.
      ...(masked ? {} : { description: form.description, ...(type === 'bug' ? { steps_to_reproduce: form.steps_to_reproduce, expected_result: form.expected_result, actual_result: form.actual_result, found_in: form.found_in } : {}) }),
    }));
  };
  return (
    <FormModal title={`Edit ${w.ref}`} submitLabel="Save" onClose={onClose} onSubmit={submit}>
      {w.mirror && <p className="muted small full">Mirrored from {w.mirror.label}: change the title, type, points, team, assignee and parent there.</p>}
      {!w.mirror && <>
        <label>Type<select value={form.type} onChange={(e) => set('type', e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
        <label>Story points<select value={form.points} onChange={(e) => set('points', e.target.value)}><option value="">Not estimated</option>{POINTS.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label className="full">Title<input required value={form.title} onChange={(e) => set('title', e.target.value)} /></label>
      </>}
      {!masked && <label className="full">Description<textarea rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} /></label>}
      {!masked && type === 'bug' && <BugFields form={form} set={set} />}
      {!w.mirror && <>
        <TeamSelect value={form.team_id} onChange={(v) => set('team_id', v)} />
        <label>Assignee<select value={form.assignee_id} onChange={(e) => set('assignee_id', e.target.value)}><option value="">Nobody</option>{meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
        <ParentSelect type={type} value={form.parent} self={w.ref} onChange={(v) => set('parent', v)} />
      </>}
      <label className="full">Labels <span className="muted small">(comma-separated)</span><input value={form.labels} onChange={(e) => set('labels', e.target.value)} /></label>
      {form.team_id !== (w.team_id ? String(w.team_id) : '') && <p className="muted small full">It goes to the bottom of that team's backlog.</p>}
    </FormModal>
  );
}
