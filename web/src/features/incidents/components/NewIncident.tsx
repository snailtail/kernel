import { useState } from 'react';
import { api } from '../../../api/client';
import { useTeams } from '../../../components/Teams';
import { ArticleSuggestions } from '../../../components/Knowledge';
import { PersonPicker } from '../../../components/People';
import { FormModal } from '../../../components/Modal';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import { Term } from '../../../components/Glossary';
import type { Incident } from '../../../api/types/incidents';
import type { PersonRef } from '../../../api/types/people';
import { LEVEL } from '../common';

export function NewIncident({ onClose, onDone }: { onClose: () => void; onDone: (ref: string) => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({ title: '', description: '', impact: 3, urgency: 3, category_id: '', assignee_id: '', assignment_group: '', team_id: '', reporter: '', cis: '' });
  const teams = useTeams();
  const [more, setMore] = useState(false);
  const [caller, setCaller] = useState<PersonRef | null>(null);
  const { data: templates } = useApi<{ id: number; name: string; fields: Record<string, any>; active: boolean }[]>('/api/templates?kind=incident');
  const applyTemplate = (id: number) => {
    const t = templates?.find((x) => x.id === id);
    if (!t) return;
    const f = t.fields;
    setForm((cur) => ({ ...cur, ...(f.title ? { title: f.title } : {}), ...(f.description ? { description: f.description } : {}), ...(f.impact ? { impact: f.impact } : {}), ...(f.urgency ? { urgency: f.urgency } : {}), ...(f.category_id ? { category_id: String(f.category_id) } : {}), ...(f.assignment_group ? { assignment_group: f.assignment_group } : {}), ...(f.cis ? { cis: f.cis.join(', ') } : {}) }));
    if (f.assignment_group || f.category_id) setMore(true);
  };
  const submit = async () => {
    const created = await api.post<Incident>('/api/incidents', {
      title: form.title, description: form.description, impact: Number(form.impact), urgency: Number(form.urgency),
      category_id: form.category_id ? Number(form.category_id) : null, assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
      ...(form.team_id ? { team_id: Number(form.team_id) } : form.assignment_group ? { assignment_group: form.assignment_group } : {}), reporter: form.reporter,
      cis: form.cis.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean),
      ...(caller ? { caller: 'id' in caller ? { id: caller.id } : caller } : {}),
    });
    onDone(created.ref);
  };
  return (
    <FormModal title="Log an incident" submitLabel="Log incident" onClose={onClose} onSubmit={submit}>
      {!!templates?.filter((t) => t.active).length && (
        <label className="full">Start from a template<select defaultValue="" onChange={(e) => applyTemplate(Number(e.target.value))}><option value="">–</option>{templates.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      )}
      <label className="full">What is wrong?<input required autoFocus placeholder="As the user experiences it, e.g. Checkout times out" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
      <label className="full">Description<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <div className="full">
        <div className="field-label">Caller <span className="muted small">(optional: who reported it – a name or email creates a contact)</span></div>
        {caller ? <span className="person-field">{'id' in caller ? caller.label : `${caller.name}${caller.email && caller.email !== caller.name ? ` <${caller.email}>` : ''} (new contact)`} <button type="button" className="btn-icon small" aria-label="Clear caller" onClick={() => setCaller(null)}>×</button></span>
          : <PersonPicker placeholder="Name or email…" onPick={setCaller} />}
      </div>
      <label><Term id="impact" /><select value={form.impact} onChange={(e) => setForm({ ...form, impact: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} – {LEVEL[n]}</option>)}</select></label>
      <label><Term id="urgency" /><select value={form.urgency} onChange={(e) => setForm({ ...form, urgency: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} – {LEVEL[n]}</option>)}</select></label>
      {meta.modules?.knowledge !== false && <ArticleSuggestions text={form.title} cis={form.cis} />}
      {meta.modules?.cmdb !== false && <label className="full">Affected CIs or services <span className="muted small">(refs, e.g. CI000012 SVC000003; shows impact and known workarounds)</span><input value={form.cis} onChange={(e) => setForm({ ...form, cis: e.target.value })} /></label>}
      <div className="full more-toggle">
        <button type="button" className="btn-link" aria-expanded={more} onClick={() => setMore(!more)}>{more ? '− Fewer details' : '+ More details'}</button>
        {!more && <span className="muted small"> team, assignee, category, reporter – all optional</span>}
      </div>
      {more && (
        <>
          <label>Assignee<select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}><option value="">–</option>{meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
          <label>Team<select value={form.team_id} onChange={(e) => setForm({ ...form, team_id: e.target.value, assignment_group: '' })}><option value="">{form.assignment_group ? `${form.assignment_group} (from the template)` : 'From the CI or service'}</option>{teams.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label>Category<select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}><option value="">–</option>{meta.categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Reported by<input value={form.reporter} onChange={(e) => setForm({ ...form, reporter: e.target.value })} /></label>
        </>
      )}
    </FormModal>
  );
}
