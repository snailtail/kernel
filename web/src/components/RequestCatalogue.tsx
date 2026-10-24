// The service request catalogue (#44), kept by managers under Administration: per service a short form, who
// approves, and the fulfilment tasks in order. The request pages read the same item shapes.
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApi } from '../hooks';
import { isManager, useSession } from '../session';
import { Modal } from './Modal';
import { useTeams } from './Teams';

export type FieldType = 'text' | 'textarea' | 'choice' | 'person' | 'ci' | 'date';
const FIELD_TYPE: Record<FieldType, string> = { text: 'Short text', textarea: 'Long text', choice: 'Choice', person: 'Person', ci: 'CI', date: 'Date' };
export interface Field { key: string; label: string; type: FieldType; required: boolean; choices: string[] }
export type TaskKind = 'manual' | 'change' | 'webhook';
interface TaskSpec { title: string; team_id: number | null; kind?: TaskKind; webhook_id?: number | null }
const TASK_KIND: Record<TaskKind, string> = { manual: 'By a person', change: 'Standard change', webhook: 'Webhook' };
export interface Item {
  id: number; name: string; description: string; form: Field[]; approval: string; approval_label: string; fulfilment_tasks: TaskSpec[];
  standard_change_template_id: number | null; logger_may_approve: boolean;
  sla_id: number | null; sla: string | null; active: boolean; service: { ref: string; name: string };
}
/** Managers keep the catalogue: per service, a short form, who approves, and the tasks in order. */
export function RequestCatalogueCard() {
  const { user } = useSession();
  const { data, reload } = useApi<Item[]>(isManager(user) ? '/api/request-items?inactive=true' : null);
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  if (!data) return null;
  return (
    <section className="card">
      <div className="section-head"><h2>Request catalogue</h2><button className="btn-link" onClick={() => setEditing('new')}>+ Item</button></div>
      <p className="muted small">What people can ask for, per service: a form of at most 10 fields, who approves, and the tasks that fulfil it, in order.</p>
      {data.length === 0 ? <p className="placeholder">No items yet. Start with the three most common requests, such as a new account or access to a system.</p> : (
        <table className="table compact">
          <thead><tr><th>Item</th><th className="hide-sm">Service</th><th className="hide-sm">Approval</th><th>Tasks</th><th /></tr></thead>
          <tbody>
            {data.map((i) => (
              <tr key={i.id} className={i.active ? '' : 'muted'}>
                <td>{i.name}{!i.active && <span className="tag">inactive</span>}</td>
                <td className="hide-sm">{i.service.name}</td>
                <td className="hide-sm small">{i.approval_label}</td>
                <td>{i.fulfilment_tasks.length}</td>
                <td><button className="btn-link small" onClick={() => setEditing(i)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <ItemModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </section>
  );
}

const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f$1').slice(0, 40) || 'field';

function ItemModal({ item, onClose, onDone }: { item: Item | null; onClose: () => void; onDone: () => void }) {
  const teams = useTeams();
  const { data: slas } = useApi<{ id: number; name: string }[]>('/api/slas');
  const [form, setForm] = useState({
    service: item?.service.ref ?? '', name: item?.name ?? '', description: item?.description ?? '', approval: item?.approval ?? 'none',
    sla_id: item?.sla_id ? String(item.sla_id) : '', active: item?.active ?? true, logger_may_approve: item?.logger_may_approve ?? false,
    standard_change_template_id: item?.standard_change_template_id ? String(item.standard_change_template_id) : '',
  });
  const { data: options } = useApi<{ templates: { id: number; name: string }[]; webhooks: { id: number; name: string }[] }>('/api/request-items/options');
  const [fields, setFields] = useState<Field[]>(item?.form ?? []);
  const [tasks, setTasks] = useState<TaskSpec[]>(item?.fulfilment_tasks ?? [{ title: '', team_id: null, kind: 'manual' }]);
  const [error, setError] = useState<string | null>(null);
  const approvalKind = form.approval.startsWith('team:') ? 'team' : form.approval;
  const setField = (n: number, patch: Partial<Field>) => setFields(fields.map((f, i) => (i === n ? { ...f, ...patch } : f)));
  const setTask = (n: number, patch: Partial<TaskSpec>) => setTasks(tasks.map((t, i) => (i === n ? { ...t, ...patch } : t)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = {
      ...form, sla_id: form.sla_id ? Number(form.sla_id) : null, standard_change_template_id: form.standard_change_template_id ? Number(form.standard_change_template_id) : null,
      form: fields.map((f) => ({ ...f, key: f.key || keyOf(f.label), choices: f.type === 'choice' ? f.choices : [] })),
      fulfilment_tasks: tasks.filter((t) => t.title.trim()),
      ...(tasks.some((t) => t.kind === 'change') ? {} : { standard_change_template_id: null }),
    };
    try {
      if (item) await api.put(`/api/request-items/${item.id}`, body);
      else await api.post('/api/request-items', body);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={item ? `Edit ${item.name}` : 'New catalogue item'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Access to a system" /></label>
        <label>Service <span className="muted small">(ref)</span><input required value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} placeholder="SVC…" /></label>
        <label className="full">Description<textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label>Approval
          <select value={approvalKind} onChange={(e) => setForm({ ...form, approval: e.target.value === 'team' ? `team:${teams[0]?.id ?? 0}` : e.target.value })}>
            <option value="none">No approval</option><option value="requester_manager">The requester's manager</option><option value="service_owner">The service owner</option><option value="team">A team</option>
          </select>
        </label>
        {approvalKind === 'team' ? (
          <label>Approving team
            <select value={form.approval.slice(5)} onChange={(e) => setForm({ ...form, approval: `team:${e.target.value}` })}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </label>
        ) : (
          <label>SLA
            <select value={form.sla_id} onChange={(e) => setForm({ ...form, sla_id: e.target.value })}><option value="">The service's SLA</option>{slas?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </label>
        )}
        {approvalKind === 'team' && (
          <label className="full">SLA
            <select value={form.sla_id} onChange={(e) => setForm({ ...form, sla_id: e.target.value })}><option value="">The service's SLA</option>{slas?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </label>
        )}

        <fieldset className="full builder">
          <legend>Form <span className="muted small">({fields.length} of 10 fields)</span></legend>
          {fields.map((f, n) => (
            <div key={n} className="builder-row">
              <input aria-label="Field label" required placeholder="Label" value={f.label} onChange={(e) => setField(n, { label: e.target.value, ...(item?.form.some((x) => x.key === f.key) ? {} : { key: keyOf(e.target.value) }) })} />
              <select aria-label="Field type" value={f.type} onChange={(e) => setField(n, { type: e.target.value as FieldType })}>{Object.entries(FIELD_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <label className="check"><input type="checkbox" checked={f.required} onChange={(e) => setField(n, { required: e.target.checked })} /> Required</label>
              <button type="button" className="btn-link small" aria-label={`Remove ${f.label || 'field'}`} onClick={() => setFields(fields.filter((_, i) => i !== n))}>Remove</button>
              {f.type === 'choice' && <input className="builder-choices" aria-label="Choices" placeholder="Choices, separated by commas" value={f.choices.join(', ')} onChange={(e) => setField(n, { choices: e.target.value.split(',').map((c) => c.trim()).filter(Boolean) })} />}
            </div>
          ))}
          {fields.length < 10 && <button type="button" className="btn small" onClick={() => setFields([...fields, { key: '', label: '', type: 'text', required: false, choices: [] }])}>+ Field</button>}
        </fieldset>

        <fieldset className="full builder">
          <legend>Fulfilment tasks, in order</legend>
          {tasks.map((t, n) => (
            <div key={n} className="builder-row">
              <span className="muted">{n + 1}.</span>
              <input aria-label="Task" required={n === 0} placeholder="What to do" value={t.title} onChange={(e) => setTask(n, { title: e.target.value })} />
              <select aria-label="Team" value={t.team_id ?? ''} onChange={(e) => setTask(n, { team_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Anyone</option>{teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select aria-label="How it is done" value={t.kind ?? 'manual'} onChange={(e) => setTask(n, { kind: e.target.value as TaskKind, webhook_id: e.target.value === 'webhook' ? options?.webhooks[0]?.id ?? null : null })}>
                {(Object.keys(TASK_KIND) as TaskKind[]).filter((k) => k === 'manual' || (k === 'change' ? !!options?.templates.length : !!options?.webhooks.length)).map((k) => <option key={k} value={k}>{TASK_KIND[k]}</option>)}
              </select>
              {t.kind === 'webhook' && (
                <select aria-label="Webhook" value={t.webhook_id ?? ''} onChange={(e) => setTask(n, { webhook_id: Number(e.target.value) })}>{options?.webhooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
              )}
              {tasks.length > 1 && <button type="button" className="btn-link small" aria-label={`Remove task ${n + 1}`} onClick={() => setTasks(tasks.filter((_, i) => i !== n))}>Remove</button>}
            </div>
          ))}
          {tasks.length < 20 && <button type="button" className="btn small" onClick={() => setTasks([...tasks, { title: '', team_id: null, kind: 'manual' }])}>+ Task</button>}
          {tasks.some((t) => t.kind === 'change') && (
            <label>Standard change template
              <select required value={form.standard_change_template_id} onChange={(e) => setForm({ ...form, standard_change_template_id: e.target.value })}>
                <option value="">Choose…</option>{options?.templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          )}
          <p className="muted small">A standard change task is completed by the change's outcome; a webhook task by the webhook calling back.</p>
        </fieldset>
        {form.approval !== 'none' && <label className="check full"><input type="checkbox" checked={form.logger_may_approve} onChange={(e) => setForm({ ...form, logger_may_approve: e.target.checked })} /> The person who logs a request may also approve it (the history shows it)</label>}
        {item && <label className="check full"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> In the catalogue (untick to retire it; existing requests keep it)</label>}
        {error && <div className="error full">{error}</div>}
        <div className="actions full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}
