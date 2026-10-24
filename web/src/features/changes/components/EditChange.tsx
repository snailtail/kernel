import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import type { Change } from '../../../api/types/changes';

const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

export function EditChange({ change: c, onClose, onDone }: { change: Change; onClose: () => void; onDone: (c: Change) => void }) {
  const [form, setForm] = useState({
    title: c.title, description: c.description, change_type: c.change_type, implementation_plan: c.implementation_plan, test_plan: c.test_plan,
    backout_plan: c.backout_plan, planned_start: local(c.planned_start), planned_end: local(c.planned_end), risk: c.risk_overridden ? c.risk : '',
  });
  return (
    <FormModal title={`Edit ${c.ref}`} submitLabel="Save" onClose={onClose} onSubmit={async () => {
      const body = {
        ...form, risk: form.risk || null,
        planned_start: form.planned_start ? new Date(form.planned_start).toISOString() : null,
        planned_end: form.planned_end ? new Date(form.planned_end).toISOString() : null,
        ...(c.template_id ? { change_type: undefined } : {}),
      };
      onDone(await api.patch<Change>(`/api/changes/${c.ref}`, body));
    }}>
      <label className="full">Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
      {!c.template_id && <label>Type<select value={form.change_type} onChange={(e) => setForm({ ...form, change_type: e.target.value })}><option value="normal">Normal</option><option value="emergency">Emergency</option></select></label>}
      <label>Risk<select value={form.risk} onChange={(e) => setForm({ ...form, risk: e.target.value })}><option value="">Assessed: {c.risk_assessed}</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <label>Planned start<input type="datetime-local" value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} /></label>
      <label>Planned end<input type="datetime-local" value={form.planned_end} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} /></label>
      <label className="full">Description<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label className="full">Implementation plan<textarea rows={3} value={form.implementation_plan} onChange={(e) => setForm({ ...form, implementation_plan: e.target.value })} /></label>
      <label className="full">Test plan<textarea rows={2} value={form.test_plan} onChange={(e) => setForm({ ...form, test_plan: e.target.value })} /></label>
      <label className="full">Backout plan<textarea rows={2} value={form.backout_plan} onChange={(e) => setForm({ ...form, backout_plan: e.target.value })} /></label>
    </FormModal>
  );
}
