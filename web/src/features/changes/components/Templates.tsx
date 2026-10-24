import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { useApi } from '../../../hooks';

export function Templates({ manager }: { manager: boolean }) {
  const { data, reload } = useApi<{ id: number; name: string; description: string; max_risk: string; ci_types: string[]; implementation_plan: string; test_plan: string; backout_plan: string; active: boolean }[]>('/api/change-templates');
  const { data: types } = useApi<{ name: string; label: string; class: string }[]>('/api/ci-types');
  const [editing, setEditing] = useState<any>(null);
  return (
    <>
      <div className="section-head"><p className="muted">Standard changes are pre-approved, low-risk and repeatable: they need no authorisation. Pipelines can register them automatically.</p>{manager && <button className="btn primary" onClick={() => setEditing({ name: '', description: '', max_risk: 'low', ci_types: [], implementation_plan: '', test_plan: '', backout_plan: '', active: true })}>New template</button>}</div>
      <div className="rule-list">
        {data?.map((t) => (
          <button key={t.id} className={`card rule-card ${t.active ? '' : 'disabled'}`} disabled={!manager} onClick={() => setEditing(t)}>
            <strong>{t.name}</strong> <span className="muted small">#{t.id}</span>{!t.active && <span className="tag">inactive</span>}
            <div className="muted small">{t.description || t.implementation_plan.slice(0, 120)}</div>
            <div className="small">Up to {t.max_risk} risk · {t.ci_types.length ? t.ci_types.join(', ') : 'any CI type'}</div>
          </button>
        ))}
      </div>
      {data?.length === 0 && <p className="empty">No standard change templates yet.</p>}
      {editing && (
        <FormModal title={editing.id ? `Edit ${editing.name}` : 'New standard change template'} submitLabel="Save" onClose={() => setEditing(null)} onSubmit={async () => {
          const { id, created_by: _c, created_at: _d, ...body } = editing;
          delete (body as any).id;
          if (id) await api.put(`/api/change-templates/${id}`, body);
          else await api.post('/api/change-templates', body);
          setEditing(null);
          reload();
        }}>
          <label className="full">Name<input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <label className="full">Description<textarea rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
          <label>Pre-approved up to<select value={editing.max_risk} onChange={(e) => setEditing({ ...editing, max_risk: e.target.value })}><option value="low">Low risk</option><option value="medium">Medium risk</option><option value="high">High risk</option></select></label>
          <label>For CI types<select multiple size={4} value={editing.ci_types} onChange={(e) => setEditing({ ...editing, ci_types: [...e.target.selectedOptions].map((o) => o.value) })}>{types?.filter((t) => t.class === 'ci').map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}</select><span className="muted small">None selected: any type</span></label>
          <label className="full">Implementation plan<textarea required rows={3} value={editing.implementation_plan} onChange={(e) => setEditing({ ...editing, implementation_plan: e.target.value })} /></label>
          <label className="full">Test plan<textarea rows={2} value={editing.test_plan} onChange={(e) => setEditing({ ...editing, test_plan: e.target.value })} /></label>
          <label className="full">Backout plan<textarea required rows={2} value={editing.backout_plan} onChange={(e) => setEditing({ ...editing, backout_plan: e.target.value })} /></label>
          <label className="check full"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active</label>
        </FormModal>
      )}
    </>
  );
}
