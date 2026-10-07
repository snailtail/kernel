import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, type LinkKind, type ProblemDetail } from '../api';
import { LEVEL_LABEL, LINK_LABEL, PRIORITY_LABEL } from '../format';
import { canEdit, isManager, useSession } from '../session';

export function NewProblemPage() {
  const { user, meta } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    title: '',
    description: '',
    category_id: '',
    affected_service: '',
    detection: 'reactive' as 'reactive' | 'proactive',
    impact: 3,
    urgency: 3,
    is_major: false,
    assignee_id: String(user.id),
    workaround: '',
  });
  const [links, setLinks] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  if (!canEdit(user)) return <p className="empty">Your role cannot log problems.</p>;

  const linkKind: LinkKind = form.detection === 'reactive' ? 'incident' : 'event';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<ProblemDetail>('/api/problems', {
        ...form,
        category_id: form.category_id ? Number(form.category_id) : null,
        assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
      });
      const refs = links.split(/[\s,;]+/).filter(Boolean);
      for (const reference of refs) {
        await api.post(`/api/problems/${created.ref}/links`, { kind: linkKind, reference }).catch(() => {});
      }
      navigate(`/problems/${created.ref}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Log problem</h1>
          <p className="muted">Problem identification – record the problem, its scope and the triggering incidents or events.</p>
        </div>
      </header>
      <form className="card form" onSubmit={submit}>
        <label className="full">
          Title
          <input autoFocus required maxLength={300} value={form.title} onChange={(e) => set('title', e.target.value)}
            placeholder="E.g. Intermittent timeouts in order service during peak hours" />
        </label>
        <label className="full">
          Description
          <textarea rows={6} value={form.description} onChange={(e) => set('description', e.target.value)}
            placeholder="Symptoms, scope, business impact, what is known so far" />
        </label>
        <fieldset className="full segmented">
          <legend>Detection</legend>
          <label className={form.detection === 'reactive' ? 'on' : ''}>
            <input type="radio" checked={form.detection === 'reactive'} onChange={() => set('detection', 'reactive')} />
            Reactive <small>from incidents</small>
          </label>
          <label className={form.detection === 'proactive' ? 'on' : ''}>
            <input type="radio" checked={form.detection === 'proactive'} onChange={() => set('detection', 'proactive')} />
            Proactive <small>from events, trends, risks</small>
          </label>
        </fieldset>
        <label className="full">
          Related {LINK_LABEL[linkKind].toLowerCase()}s
          <input value={links} onChange={(e) => setLinks(e.target.value)}
            placeholder={linkKind === 'incident' ? 'INC0012345, INC0012399' : 'EVT-4711, alert IDs'} />
          <small className="muted">Separate several references with commas. System and URL can be added later.</small>
        </label>
        <label>
          Category
          <select value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
            <option value="">–</option>
            {meta.categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>
          Affected service / CI
          <input value={form.affected_service} onChange={(e) => set('affected_service', e.target.value)} />
        </label>
        <label>
          Impact
          <select value={form.impact} onChange={(e) => set('impact', Number(e.target.value))}>
            {[1, 2, 3].map((l) => <option key={l} value={l}>{l} – {LEVEL_LABEL[l]}</option>)}
          </select>
        </label>
        <label>
          Urgency
          <select value={form.urgency} onChange={(e) => set('urgency', Number(e.target.value))}>
            {[1, 2, 3].map((l) => <option key={l} value={l}>{l} – {LEVEL_LABEL[l]}</option>)}
          </select>
        </label>
        <div className="computed">
          Priority: <strong>P{form.impact + form.urgency - 1} {PRIORITY_LABEL[form.impact + form.urgency - 1]}</strong>
        </div>
        <label>
          Assignee
          <select value={form.assignee_id} onChange={(e) => set('assignee_id', e.target.value)}>
            <option value="">Unassigned</option>
            {meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
          </select>
        </label>
        {isManager(user) && (
          <label className="check full">
            <input type="checkbox" checked={form.is_major} onChange={(e) => set('is_major', e.target.checked)} />
            Major problem – requires a major problem review before closure
          </label>
        )}
        <label className="full">
          Workaround <small className="muted">(optional, if one is already known)</small>
          <textarea rows={3} value={form.workaround} onChange={(e) => set('workaround', e.target.value)} />
        </label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={() => navigate(-1)}>Cancel</button>
          <button className="btn primary" disabled={busy || !form.title.trim()}>{busy ? 'Saving…' : 'Log problem'}</button>
        </div>
      </form>
    </>
  );
}
