import { useState } from 'react';
import { api } from '../../../api/client';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import { FormModal } from '../../../components/Modal';
import type { RecordTemplate, TemplateFields } from '../../../api/types/admin';

/** Templates that prefill new incidents and problems for common issues. */
export function TemplatesCard() {
  const { meta } = useSession();
  const { data, reload } = useApi<RecordTemplate[]>('/api/templates');
  const [editing, setEditing] = useState<Partial<RecordTemplate> | null>(null);
  const kinds = (['problem', ...(meta.modules?.incident !== false ? ['incident'] : [])] as const);
  const f = editing?.fields ?? {};
  const setF = (patch: Partial<TemplateFields>) => setEditing({ ...editing, fields: { ...f, ...patch } });
  return (
    <section className="card">
      <div className="section-head"><h2>Templates</h2><button className="btn-link" onClick={() => setEditing({ kind: 'problem', name: '', fields: {}, active: true })}>+ Template</button></div>
      <p className="muted small">Prefill new {kinds.join(' and ')} records for issues that come back.</p>
      {data?.length === 0 && <p className="placeholder">No templates yet.</p>}
      <ul className="plain-list">
        {data?.map((t) => <li key={t.id}><button className="btn-link" onClick={() => setEditing(t)}>{t.name}</button> <span className="tag">{t.kind}</span>{!t.active && <span className="muted small"> inactive</span>}</li>)}
      </ul>
      {editing && (
        <FormModal title={editing.id ? `Edit ${editing.name}` : 'New template'} submitLabel="Save" onClose={() => setEditing(null)} onSubmit={async () => {
          const body = { kind: editing.kind, name: editing.name, fields: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined)), active: editing.active ?? true };
          if (editing.id) await api.put(`/api/templates/${editing.id}`, body);
          else await api.post('/api/templates', body);
          setEditing(null);
          reload();
        }}>
          <label>For<select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as 'problem' })}>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label>Name<input required value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <label className="full">Title<input value={f.title ?? ''} onChange={(e) => setF({ title: e.target.value })} /></label>
          <label className="full">Description<textarea rows={3} value={f.description ?? ''} onChange={(e) => setF({ description: e.target.value })} /></label>
          <label>Impact<select value={f.impact ?? ''} onChange={(e) => setF({ impact: e.target.value ? Number(e.target.value) : undefined })}><option value="">–</option>{[1, 2, 3].map((n) => <option key={n}>{n}</option>)}</select></label>
          <label>Urgency<select value={f.urgency ?? ''} onChange={(e) => setF({ urgency: e.target.value ? Number(e.target.value) : undefined })}><option value="">–</option>{[1, 2, 3].map((n) => <option key={n}>{n}</option>)}</select></label>
          <label>Category<select value={f.category_id ?? ''} onChange={(e) => setF({ category_id: e.target.value ? Number(e.target.value) : undefined })}><option value="">–</option>{meta.categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          {editing.kind === 'incident' && <label>Assignment group<input value={f.assignment_group ?? ''} onChange={(e) => setF({ assignment_group: e.target.value })} /></label>}
          <label className="check full"><input type="checkbox" checked={editing.active ?? true} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active</label>
        </FormModal>
      )}
    </section>
  );
}
