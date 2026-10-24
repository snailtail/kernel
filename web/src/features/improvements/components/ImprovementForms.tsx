import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { useSession } from '../../../session';
import type { Improvement } from '../../../api/types/improvements';
import { KPI_LABEL, ModelHint } from '../common';

function RatingSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label>{label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not rated</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

export function NewImprovement({ prefill, onClose, onDone }: { prefill: Record<string, string>; onClose: () => void; onDone: (ref: string) => void }) {
  const fromReport = prefill.source === 'service_review' && prefill.service;
  const [form, setForm] = useState({
    title: '', service: prefill.service ?? '', value: '', effort: '', kpi: prefill.kpi && KPI_LABEL[prefill.kpi] ? prefill.kpi : '',
    description: fromReport ? `From the service review of ${prefill.service}${prefill.from ? `, ${prefill.from} – ${prefill.to}` : ''}.\n\n` : '',
  });
  const submit = async () => {
    const m = await api.post<Improvement>('/api/improvements', {
      title: form.title, description: form.description,
      ...(form.service ? { service: form.service } : {}), ...(form.value ? { value: Number(form.value) } : {}), ...(form.effort ? { effort: Number(form.effort) } : {}),
      ...(form.kpi ? { kpi: form.kpi } : {}),
      ...(prefill.source ? { source: prefill.source } : {}), ...(fromReport ? { source_ref: prefill.service } : prefill.source_ref ? { source_ref: prefill.source_ref } : {}),
    });
    onDone(m.ref);
  };
  return (
    <FormModal title="Suggest an improvement" submitLabel="Suggest" intro={<ModelHint />} onClose={onClose} onSubmit={submit}>
      <label className="full">What should get better?<input required autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Alert 30 days before a certificate expires" /></label>
      <label className="full">Where we are, and where we want to be<textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label>Service <span className="muted small">(ref)</span><input value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} placeholder="SVC…" /></label>
      <label>KPI to watch
        <select value={form.kpi} onChange={(e) => setForm({ ...form, kpi: e.target.value })}><option value="">None</option>{Object.entries(KPI_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
      <RatingSelect label="Value (1–5)" value={form.value} onChange={(value) => setForm({ ...form, value })} />
      <RatingSelect label="Effort (1–5)" value={form.effort} onChange={(effort) => setForm({ ...form, effort })} />
    </FormModal>
  );
}

export function EditImprovement({ m, onClose, onDone }: { m: Improvement; onClose: () => void; onDone: (m: Improvement) => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({
    title: m.title, description: m.description ?? '', benefit: m.benefit ?? '', service: m.service?.ref ?? '', owner_id: m.owner_id ? String(m.owner_id) : '',
    value: m.value ? String(m.value) : '', effort: m.effort ? String(m.effort) : '', kpi: m.kpi ?? '',
  });
  const masked = !!m.confidential_masked;
  const submit = async () => {
    onDone(await api.patch<Improvement>(`/api/improvements/${m.ref}`, {
      title: form.title, service: form.service || null, owner_id: form.owner_id ? Number(form.owner_id) : null,
      value: form.value ? Number(form.value) : null, effort: form.effort ? Number(form.effort) : null, kpi: form.kpi || null,
      // A confidential improvement's text is only sent by people who may read it.
      ...(masked ? {} : { description: form.description, ...(form.benefit !== (m.benefit ?? '') ? { benefit: form.benefit } : {}) }),
    }));
  };
  return (
    <FormModal title={`Edit ${m.ref}`} submitLabel="Save" onClose={onClose} onSubmit={submit}>
      <label className="full">Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
      {!masked && <label className="full">Description<textarea rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>}
      {!masked && ['in_progress', 'done'].includes(m.status) && <label className="full">Benefit<textarea rows={3} value={form.benefit} onChange={(e) => setForm({ ...form, benefit: e.target.value })} /></label>}
      <label>Owner<select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}><option value="">No owner</option>{meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
      <label>Service <span className="muted small">(ref)</span><input value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} /></label>
      <RatingSelect label="Value (1–5)" value={form.value} onChange={(value) => setForm({ ...form, value })} />
      <RatingSelect label="Effort (1–5)" value={form.effort} onChange={(effort) => setForm({ ...form, effort })} />
      <label className="full">KPI to watch
        <select value={form.kpi} onChange={(e) => setForm({ ...form, kpi: e.target.value })}><option value="">None</option>{Object.entries(KPI_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
    </FormModal>
  );
}
