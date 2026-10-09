import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type ProblemDetail } from '../api';
import { Modal } from '../components/Modal';
import { formatDate, LEVEL_LABEL, relativeTime } from '../format';
import { useApi } from '../hooks';
import { canEdit, isManager, useSession } from '../session';

interface CandidateRecord { id: number; system: string; kind: 'incident' | 'event'; reference: string; summary: string; category: string; occurred_at: string }
interface Candidate { service: string; ci_ref: string | null; ci_class: string | null; count: number; incidents: number; events: number; first_at: string; last_at: string; records: CandidateRecord[] }
interface Candidates { rule: { min_records: number; window_days: number }; candidates: Candidate[] }

export function CandidatesPage() {
  const { user } = useSession();
  const { data, reload } = useApi<Candidates>('/api/candidates');
  const [creating, setCreating] = useState<Candidate | null>(null);
  const [linking, setLinking] = useState<Candidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editable = canEdit(user);

  const dismiss = async (c: Candidate) => {
    if (!confirm(`Dismiss ${c.count} records for ${c.service}? They will no longer count towards candidates.`)) return;
    try {
      await api.post('/api/candidates/dismiss', { record_ids: c.records.map((r) => r.id) });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Problem candidates</h1>
          <p className="muted">
            Proactive problem identification: services with recurring incidents or events that are not yet linked to a problem.
          </p>
        </div>
      </header>
      {data && <RuleCard rule={data.rule} editable={isManager(user)} onSaved={reload} />}
      {error && <div className="error">{error}</div>}
      {data?.candidates.length === 0 && (
        <section className="card">
          <p className="empty">
            No candidates right now. Candidates appear when integrations report at least {data.rule.min_records} unlinked incidents or events for the same
            service within {data.rule.window_days} days. See the API section under Settings for how to report records.
          </p>
        </section>
      )}
      <div className="candidates">
        {data?.candidates.map((c) => (
          <article key={`${c.ci_ref ?? ''}${c.service}`} className="card candidate">
            <header>
              <div>
                <h2>{c.service} {c.ci_ref && <Link to={`/cis/${c.ci_ref}`} className="mono small">{c.ci_ref}</Link>}</h2>
                <p className="muted small">
                  {c.incidents} incident{c.incidents === 1 ? '' : 's'} · {c.events} event{c.events === 1 ? '' : 's'} · first {relativeTime(c.first_at)}, latest {relativeTime(c.last_at)}
                </p>
              </div>
              <span className="candidate-count">{c.count}</span>
            </header>
            <ul className="record-list">
              {c.records.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <span className={`kind kind-${r.kind}`}>{r.kind}</span>
                  <span className="mono">{r.reference}</span>
                  <span className="record-summary">{r.summary}</span>
                  <time className="muted small" title={formatDate(r.occurred_at)}>{relativeTime(r.occurred_at)}</time>
                </li>
              ))}
              {c.records.length > 8 && <li className="muted small">and {c.records.length - 8} more</li>}
            </ul>
            {editable && (
              <div className="actions">
                <button className="btn-link spacer-right" onClick={() => dismiss(c)}>Dismiss</button>
                <button className="btn" onClick={() => setLinking(c)}>Link to existing problem</button>
                <button className="btn primary" onClick={() => setCreating(c)}>Log problem</button>
              </div>
            )}
          </article>
        ))}
      </div>
      {creating && <CreateModal candidate={creating} onClose={() => setCreating(null)} />}
      {linking && <LinkModal candidate={linking} onClose={() => setLinking(null)} />}
    </>
  );
}

function RuleCard({ rule, editable, onSaved }: { rule: Candidates['rule']; editable: boolean; onSaved: () => void }) {
  const [form, setForm] = useState(rule);
  const [editing, setEditing] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    await api.put('/api/candidates/rule', form);
    setEditing(false);
    onSaved();
  };
  return (
    <div className="rule-line">
      {editing ? (
        <form className="inline-form" onSubmit={save}>
          At least <input type="number" min={2} value={form.min_records} onChange={(e) => setForm({ ...form, min_records: Number(e.target.value) })} />
          records for the same service within <input type="number" min={1} value={form.window_days} onChange={(e) => setForm({ ...form, window_days: Number(e.target.value) })} /> days
          <button className="btn small primary">Save</button>
          <button type="button" className="btn small" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <span className="muted">
          Rule: at least <strong>{rule.min_records}</strong> unlinked records for the same service within <strong>{rule.window_days}</strong> days.
          {editable && <> <button className="btn-link" onClick={() => setEditing(true)}>Change</button></>}
        </span>
      )}
    </div>
  );
}

function CreateModal({ candidate: c, onClose }: { candidate: Candidate; onClose: () => void }) {
  const navigate = useNavigate();
  const { meta } = useSession();
  const [form, setForm] = useState({
    title: `Recurring ${c.incidents >= c.events ? 'incidents' : 'events'} on ${c.service}`,
    description: c.records.slice(0, 10).map((r) => `- ${r.reference}: ${r.summary}`).join('\n'),
    impact: 2,
    urgency: 2,
    category_id: '',
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await api.post<ProblemDetail>('/api/candidates/create', {
        record_ids: c.records.map((r) => r.id),
        problem: { ...form, category_id: form.category_id ? Number(form.category_id) : null, detection: 'proactive', affected_service: c.service === 'Unspecified' ? '' : c.service },
      });
      navigate(`/problems/${p.ref}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Log problem from candidate" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint full">The {c.count} records will be linked to the new problem, which is logged as proactively identified.</p>
        <label className="full">Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label className="full">Description<textarea rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label>Impact
          <select value={form.impact} onChange={(e) => setForm({ ...form, impact: Number(e.target.value) })}>{[1, 2, 3].map((l) => <option key={l} value={l}>{l} – {LEVEL_LABEL[l]}</option>)}</select>
        </label>
        <label>Urgency
          <select value={form.urgency} onChange={(e) => setForm({ ...form, urgency: Number(e.target.value) })}>{[1, 2, 3].map((l) => <option key={l} value={l}>{l} – {LEVEL_LABEL[l]}</option>)}</select>
        </label>
        <label>Category
          <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
            <option value="">–</option>
            {meta.categories.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Log problem</button>
        </div>
      </form>
    </Modal>
  );
}

function LinkModal({ candidate: c, onClose }: { candidate: Candidate; onClose: () => void }) {
  const navigate = useNavigate();
  const [ref, setRef] = useState('');
  const { data: open } = useApi<{ ref: string; title: string }[]>(`/api/problems?${new URLSearchParams({ q: c.service === 'Unspecified' ? '' : c.service })}`);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await api.post<ProblemDetail>('/api/candidates/link', { ref, record_ids: c.records.map((r) => r.id) });
      navigate(`/problems/${p.ref}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={`Link ${c.count} records to a problem`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="full">Problem reference
          <input required autoFocus placeholder="PRB000123" value={ref} onChange={(e) => setRef(e.target.value)} list="candidate-problems" />
          <datalist id="candidate-problems">
            {open?.map((p) => <option key={p.ref} value={p.ref}>{p.title}</option>)}
          </datalist>
        </label>
        {open && open.length > 0 && (
          <div className="full suggestions">
            <span className="muted small">Open problems mentioning {c.service}:</span>
            {open.slice(0, 5).map((p) => (
              <button type="button" key={p.ref} className="chip-btn" onClick={() => setRef(p.ref)}>{p.ref} {p.title}</button>
            ))}
          </div>
        )}
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <Link to="/problems" className="btn-link spacer-right">Browse problems</Link>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Link records</button>
        </div>
      </form>
    </Modal>
  );
}
