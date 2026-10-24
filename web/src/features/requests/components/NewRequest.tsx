import { useState, type FormEvent } from 'react';
import { api } from '../../../api/client';
import { Modal } from '../../../components/Modal';
import { PersonPicker } from '../../../components/People';
import { useApi } from '../../../hooks';
import type { RequestDetail, CatalogueItem, Field } from '../../../api/types/requests';
import type { PersonRef } from '../../../api/types/people';

// ---- New request ---------------------------------------------------------------------------

/** One answer input, by the field's type. People are picked from People; CIs and dates are typed. */
function AnswerInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const [person, setPerson] = useState<string | null>(null);
  const id = `answer-${field.key}`;
  const label = <span>{field.label}{field.required && <span className="muted"> *</span>}</span>;
  switch (field.type) {
    case 'textarea':
      return <label className="full" htmlFor={id}>{label}<textarea id={id} rows={3} required={field.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} /></label>;
    case 'choice':
      return (
        <label htmlFor={id}>{label}
          <select id={id} required={field.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>{field.choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      );
    case 'date':
      return <label htmlFor={id}>{label}<input id={id} type="date" required={field.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} /></label>;
    case 'ci':
      return <label htmlFor={id}>{label}<input id={id} required={field.required} placeholder="CI ref, e.g. CI000123" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} /></label>;
    case 'person':
      return (
        <div className="field">
          <span className="label">{label}</span>
          {value ? <p>{person ?? `Person #${value}`} <button type="button" className="btn-link small" onClick={() => onChange(undefined)}>Change</button></p>
            : <PersonPicker placeholder="Find a person…" onPick={async (p) => { const pid = await personId(p); setPerson('label' in p && p.label ? p.label : 'name' in p ? p.name : null); onChange(pid); }} />}
        </div>
      );
    default:
      return <label htmlFor={id}>{label}<input id={id} required={field.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} /></label>;
  }
}

/** A picked contact, added to People first when it is new. */
async function personId(p: PersonRef) {
  if ('id' in p) return p.id;
  return (await api.post<{ id: number }>('/api/people', { name: p.name, email: p.email ?? null })).id;
}

export function NewRequest({ onClose, onDone }: { onClose: () => void; onDone: (ref: string) => void }) {
  const { data: items } = useApi<CatalogueItem[]>('/api/request-items');
  const [item, setItem] = useState<CatalogueItem | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [requester, setRequester] = useState<{ id: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const services = [...new Map((items ?? []).map((i) => [i.service.ref, i.service.name])).entries()];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!item) return;
    setError(null);
    setBusy(true);
    try {
      const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== undefined && v !== ''));
      const r = await api.post<RequestDetail>('/api/requests', { item_id: item.id, answers: filled, ...(requester ? { requester: { id: requester.id } } : {}) });
      onDone(r.ref);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={item ? item.name : 'New request'} onClose={onClose}>
      {!item ? (
        <div className="catalogue-picker">
          <p className="muted small">What does the person need? Pick from the catalogue.</p>
          {items?.length === 0 && <p className="placeholder">The catalogue is empty. A manager adds items under Administration.</p>}
          {services.map(([ref, name]) => (
            <section key={ref}>
              <h3>{name}</h3>
              <ul className="plain-list catalogue-items">
                {items!.filter((i) => i.service.ref === ref).map((i) => (
                  <li key={i.id}>
                    <button type="button" className="catalogue-item" onClick={() => { setItem(i); setAnswers({}); }}>
                      <strong>{i.name}</strong>
                      {i.description && <span className="muted small">{i.description}</span>}
                      <span className="muted small">{i.approval === 'none' ? 'No approval' : `Approved by ${i.approval_label.toLowerCase()}`} · {i.fulfilment_tasks.length} task{i.fulfilment_tasks.length === 1 ? '' : 's'}{i.sla ? ` · ${i.sla}` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          {item.description && <p className="muted small full">{item.description}</p>}
          <div className="field full">
            <span className="label">For</span>
            {requester ? <p>{requester.label} <button type="button" className="btn-link small" onClick={() => setRequester(null)}>Change</button></p>
              : <PersonPicker placeholder="Yourself, or find the person it is for…" onPick={async (p) => setRequester({ id: await personId(p), label: 'label' in p && p.label ? p.label : 'name' in p ? p.name : '' })} />}
          </div>
          {item.form.map((f) => <AnswerInput key={f.key} field={f} value={answers[f.key]} onChange={(v) => setAnswers({ ...answers, [f.key]: v })} />)}
          <p className="muted small full">{item.approval === 'none' ? 'No approval needed: the first task starts at once.' : `${item.approval_label} approves it before work starts.`}</p>
          {error && <div className="error full">{error}</div>}
          <div className="actions full">
            <button type="button" className="btn" onClick={() => setItem(null)}>Back</button>
            <button className="btn primary" disabled={busy}>Submit</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
