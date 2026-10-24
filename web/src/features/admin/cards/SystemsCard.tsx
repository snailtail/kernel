import { useState } from 'react';
import { api } from '../../../api/client';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import { FormModal } from '../../../components/Modal';
import type { ExternalSystem } from '../../../api/types/admin';

export function SystemsCard() {
  const { meta } = useSession();
  const { data, reload } = useApi<ExternalSystem[]>('/api/systems');
  const [editing, setEditing] = useState<ExternalSystem | 'new' | null>(null);
  return (
    <section className="card">
      <div className="section-head">
        <h2>External systems</h2>
        <button className="btn primary small" onClick={() => setEditing('new')}>Add system</button>
      </div>
      <p className="muted small">URL templates turn linked references into links, e.g. <code>{'https://example.service-now.com/incident.do?sysparm_query=number={ref}'}</code>.</p>
      {data?.length === 0 && <p className="empty">No external systems yet.</p>}
      {data && data.length > 0 && (
        <table className="table compact">
          <thead><tr><th>System</th>{meta.link_kinds.map((k) => <th key={k}>{k}</th>)}<th /></tr></thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'inactive'}>
                <td>{s.name}</td>
                {meta.link_kinds.map((k) => <td key={k}>{s.url_templates[k] ? '✓' : '–'}</td>)}
                <td><button className="btn-link" onClick={() => setEditing(s)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <SystemModal system={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </section>
  );
}

function SystemModal({ system, onClose, onDone }: { system: ExternalSystem | null; onClose: () => void; onDone: () => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({ name: system?.name ?? '', url_templates: { ...(system?.url_templates ?? {}) }, active: system?.active ?? true });
  const submit = async () => {
    if (system) await api.put(`/api/systems/${system.id}`, form);
    else await api.post('/api/systems', form);
    onDone();
  };
  return (
    <FormModal title={system ? `Edit ${system.name}` : 'Add external system'} submitLabel="Save" onClose={onClose} onSubmit={submit}>
      <label className="full">Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ServiceNow, Jira, Zabbix…" /></label>
      {meta.link_kinds.map((k) => (
        <label key={k} className="full">URL template for {k}s
          <input value={form.url_templates[k] ?? ''} placeholder="https://…{ref}" onChange={(e) => setForm({ ...form, url_templates: { ...form.url_templates, [k]: e.target.value } })} />
        </label>
      ))}
      <label className="check full"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
    </FormModal>
  );
}
