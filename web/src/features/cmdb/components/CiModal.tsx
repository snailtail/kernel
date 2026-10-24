import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { PersonField } from '../../../components/People';
import { Term } from '../../../components/Glossary';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import type { Ci, CiType } from '../../../api/types/cmdb';
import { CRITICALITY } from '../common';

export function CiModal({ types, ci, onClose, onDone }: { types: CiType[]; ci?: Ci; onClose: () => void; onDone: (ci: Ci) => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({
    name: ci?.name ?? '', ci_type: ci?.ci_type ?? 'virtual_machine', environment: ci?.environment ?? 'prod', criticality: ci?.criticality ?? 3,
    team: ci?.team ?? '', owner_id: ci?.owner_id ? String(ci.owner_id) : '', tags: (ci?.tags ?? []).join(', '), description: ci?.description ?? '',
    attributes: Object.fromEntries(Object.entries(ci?.attributes ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>,
    source_system: '', source_id: '', source_url: '',
    sla_id: ci?.sla_id ? String(ci?.sla_id) : '', user_description: ci?.user_description ?? '', how_to_get_help: ci?.how_to_get_help ?? '', in_catalogue: !!ci?.in_catalogue,
    has_end_users: !!ci?.has_end_users,
    business_owner: ci?.business_owner_id ? { id: ci.business_owner_id, name: ci.business_owner ?? '' } : null as { id: number; name: string } | null,
    technical_contact: ci?.technical_contact_id ? { id: ci.technical_contact_id, name: ci.technical_contact ?? '' } : null as { id: number; name: string } | null,
  });
  const { data: slas } = useApi<{ id: number; name: string }[]>('/api/slas');
  const type = types.find((t) => t.name === form.ci_type);
  const submit = async () => {
    const body = {
      name: form.name, ci_type: form.ci_type, environment: form.environment, criticality: Number(form.criticality), team: form.team,
      owner_id: form.owner_id ? Number(form.owner_id) : null, description: form.description,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean), attributes: form.attributes,
      ...(type?.class === 'service' ? { sla_id: form.sla_id ? Number(form.sla_id) : null, user_description: form.user_description, how_to_get_help: form.how_to_get_help, in_catalogue: form.in_catalogue, has_end_users: form.has_end_users, business_owner_id: form.business_owner?.id ?? null, technical_contact_id: form.technical_contact?.id ?? null } : {}),
      ...(!ci && form.source_system && form.source_id ? { source: { system: form.source_system, id: form.source_id, url: form.source_url } } : {}),
    };
    onDone(ci ? await api.patch<Ci>(`/api/cis/${ci.ref}`, body) : await api.post<Ci>('/api/cis', body));
  };
  return (
    <FormModal title={ci ? `Edit ${ci.ref}` : 'Add a CI or service'} submitLabel="Save" onClose={onClose} onSubmit={submit}>
      <label className="full">Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>Type
        <select value={form.ci_type} onChange={(e) => setForm({ ...form, ci_type: e.target.value })}>
          <optgroup label="Services">{types.filter((t) => t.class === 'service' && t.active && (!ci || ci.class === 'service')).map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}</optgroup>
          <optgroup label="Configuration items">{types.filter((t) => t.class === 'ci' && t.active && (!ci || ci.class === 'ci')).map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}</optgroup>
        </select>
      </label>
      <label>Environment<select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>{['prod', 'test', 'dev', 'other'].map((x) => <option key={x}>{x}</option>)}</select></label>
      <label><Term id="criticality" /><select value={form.criticality} onChange={(e) => setForm({ ...form, criticality: Number(e.target.value) })}>{[1, 2, 3, 4].map((c) => <option key={c} value={c}>{c} – {CRITICALITY[c]}</option>)}</select></label>
      <label>Owner<select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}><option value="">–</option>{meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
      <label>Team<input value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} /></label>
      <label>Tags<input value={form.tags} placeholder="app=payroll, pci" onChange={(e) => setForm({ ...form, tags: e.target.value })} /></label>
      {type?.attributes.map((a) => (
        <label key={a.key}>{a.label}<input type={a.type === 'number' ? 'number' : 'text'} value={form.attributes[a.key] ?? ''} onChange={(e) => setForm({ ...form, attributes: { ...form.attributes, [a.key]: e.target.value } })} /></label>
      ))}
      <label className="full">Description<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      {type?.class === 'service' && (
        <fieldset className="full source-fields">
          <legend>Service catalogue</legend>
          <label>SLA<select value={form.sla_id} onChange={(e) => setForm({ ...form, sla_id: e.target.value })}><option value="">Default</option>{slas?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>For users<textarea rows={2} placeholder="What the service is, in plain words" value={form.user_description} onChange={(e) => setForm({ ...form, user_description: e.target.value })} /></label>
          <label>How to get help<textarea rows={2} value={form.how_to_get_help} onChange={(e) => setForm({ ...form, how_to_get_help: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={form.in_catalogue} onChange={(e) => setForm({ ...form, in_catalogue: e.target.checked })} /> Show in the service catalogue</label>
          <label className="check"><input type="checkbox" checked={form.has_end_users} onChange={(e) => setForm({ ...form, has_end_users: e.target.checked })} /> Has end users <span className="muted small">(incidents ask who is affected)</span></label>
          <label>Business owner<PersonField value={form.business_owner} placeholder="Business owner: name or email…" onChange={(v) => setForm({ ...form, business_owner: v })} /></label>
          <label>Technical contact<PersonField value={form.technical_contact} placeholder="Technical contact: name or email…" onChange={(v) => setForm({ ...form, technical_contact: v })} /></label>
        </fieldset>
      )}
      {!ci && (
        <fieldset className="full source-fields">
          <legend>Source <span className="muted small">(optional: where it lives)</span></legend>
          <input placeholder="System, e.g. vCenter" value={form.source_system} onChange={(e) => setForm({ ...form, source_system: e.target.value })} />
          <input placeholder="Id in that system" value={form.source_id} onChange={(e) => setForm({ ...form, source_id: e.target.value })} />
          <input type="url" placeholder="https://… link to it" value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })} />
        </fieldset>
      )}
    </FormModal>
  );
}
