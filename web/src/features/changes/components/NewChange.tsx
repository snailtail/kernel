import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { Term } from '../../../components/Glossary';
import { useApi } from '../../../hooks';
import type { Change } from '../../../api/types/changes';

export function NewChange({ onClose, onDone }: { onClose: () => void; onDone: (ref: string) => void }) {
  const { data: templates } = useApi<{ id: number; name: string; active: boolean }[]>('/api/change-templates');
  const [form, setForm] = useState({ title: '', description: '', change_type: 'normal', template_id: '', cis: '', planned_start: '', planned_end: '' });
  const submit = async () => {
    const c = await api.post<Change>('/api/changes', {
      title: form.title, description: form.description,
      ...(form.change_type === 'standard' ? { template_id: Number(form.template_id) } : { change_type: form.change_type }),
      cis: form.cis.split(/[\s,]+/).filter(Boolean),
      ...(form.planned_start ? { planned_start: new Date(form.planned_start).toISOString() } : {}),
      ...(form.planned_end ? { planned_end: new Date(form.planned_end).toISOString() } : {}),
    });
    onDone(c.ref);
  };
  return (
    <FormModal title="Request a change" submitLabel="Request" onClose={onClose} onSubmit={submit}>
      <label className="full">What will change?<input required autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
      <label>Type <span className="muted small">(<Term id="standard_change">standard</Term> · <Term id="emergency_change">emergency</Term>)</span><select value={form.change_type} onChange={(e) => setForm({ ...form, change_type: e.target.value })}><option value="normal">Normal</option><option value="standard">Standard (pre-approved)</option><option value="emergency">Emergency</option></select></label>
      {form.change_type === 'standard' && (
        <label>Template<select required value={form.template_id} onChange={(e) => setForm({ ...form, template_id: e.target.value })}><option value="">–</option>{templates?.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      )}
      <label className="full">Why and what<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label className="full">Affected CIs <span className="muted small">(refs; risk and collisions come from them)</span><input value={form.cis} onChange={(e) => setForm({ ...form, cis: e.target.value })} /></label>
      <label>Planned start<input type="datetime-local" value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} /></label>
      <label>Planned end<input type="datetime-local" value={form.planned_end} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} /></label>
    </FormModal>
  );
}
