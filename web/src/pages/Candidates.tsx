import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type ProblemDetail } from '../api';
import { Modal } from '../components/Modal';
import { formatDate, LEVEL_LABEL, relativeTime } from '../format';
import { useApi } from '../hooks';
import { canEdit, isManager, useSession } from '../session';

type RuleId = 'recurring_records' | 'common_upstream' | 'major_without_problem' | 'recurring_resolution' | 'reported'
  | 'flapping' | 'rising_warnings' | 'capacity_warnings' | 'self_clearing' | 'change_correlation';
interface EvidenceRecord {
  key: string; kind: 'incident' | 'event' | 'external' | 'change'; id: number | null; incident_ref: string | null; alert_id: number | null; change_ref?: string | null; system: string; reference: string;
  summary: string; category: string; occurred_at: string | null; ci_ref: string | null; resolution_code?: string | null; url?: string | null; note?: string | null;
}
interface Series { label: string; unit: string; points: { day: string; value: number }[]; split?: string }
interface Candidate {
  key: string; rule: RuleId; rule_label: string; proactive: boolean; reason: string; subject: { type: string; ref: string | null; name: string };
  service: string; ci_ref: string | null; source?: string; contains_personal_data?: boolean; count: number; incidents: number; events: number; first_at: string | null; last_at: string | null;
  evidence: { records: EvidenceRecord[]; total_records: number; series?: Series[]; cis: { ref: string; name: string; role: 'subject' | 'upstream' | 'affected'; depth?: number }[]; notes?: string };
  decision?: { decision: 'dismissed' | 'snoozed'; until: string | null; reason: string; by: string | null; at: string };
}
interface Rule { rule: RuleId; label: string; description: string; enabled: boolean; settings: Record<string, number>; count: number }
interface Candidates { rules: Rule[]; hidden: { dismissed: number; snoozed: number }; candidates: Candidate[] }

const SETTING_LABEL: Record<string, string> = {
  min_records: 'At least (records)', min_cis: 'On at least (CIs)', window_days: 'Within (days)', max_depth: 'Dependency steps',
  min_flaps: 'At least (reopenings)', min_events: 'At least (events)', factor_percent: 'Growth (%)', min_firings: 'At least (firings)',
  max_minutes: 'Cleared within (min)', min_changes: 'At least (changes)', min_percent: 'Bad (%)', within_hours: 'Incident within (hours)',
};
/** The rule's description with its current values filled in, for people who cannot change it. */
const describe = (r: Rule) => r.description.replace(/\b[a-z]+_[a-z_]+\b/g, (k) => (k in r.settings ? String(r.settings[k]) : k));

export function CandidatesPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const rule = (params.get('rule') ?? '') as RuleId | '';
  const show = params.get('show') === 'hidden' ? 'hidden' : 'open';
  const { data, reload } = useApi<Candidates>(`/api/candidates?${new URLSearchParams({ ...(rule ? { rule } : {}), show })}`);
  const [creating, setCreating] = useState<Candidate | null>(null);
  const [linking, setLinking] = useState<Candidate | null>(null);
  const [deciding, setDeciding] = useState<Candidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editable = canEdit(user);
  const set = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? p.set(k, v) : p.delete(k);
    setParams(p, { replace: true });
  };
  const restore = async (c: Candidate) => {
    try {
      await api.post('/api/candidates/restore', { key: c.key });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const active = data?.rules.filter((r) => r.enabled) ?? [];
  const total = active.reduce((n, r) => n + r.count, 0);
  const hiddenCount = (data?.hidden.dismissed ?? 0) + (data?.hidden.snoozed ?? 0);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Problem candidates</h1>
          <p className="muted">
            Records worth a problem, found by rules over incidents, events and the CMDB, or reported by external analysis. Each says why, with the evidence.
          </p>
        </div>
      </header>
      {data && (
        <div className="candidate-toolbar">
          <div className="tabs" role="group" aria-label="Rule">
            <button className={!rule ? 'on' : ''} onClick={() => set({ rule: '' })}>All <span className="muted">{total}</span></button>
            {active.map((r) => (
              <button key={r.rule} className={rule === r.rule ? 'on' : ''} onClick={() => set({ rule: r.rule })}>{r.label} <span className="muted">{r.count}</span></button>
            ))}
          </div>
          <button className="btn-link" onClick={() => set({ show: show === 'hidden' ? '' : 'hidden' })}>
            {show === 'hidden' ? 'Back to open candidates' : `Dismissed and snoozed (${hiddenCount})`}
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {data?.candidates.length === 0 && (
        <section className="card">
          <p className="empty">
            {show === 'hidden'
              ? 'Nothing is dismissed or snoozed.'
              : 'No candidates right now. They appear when a rule below finds something, or when a tool reports one (see the API section under Settings).'}
          </p>
        </section>
      )}
      {data && [false, true].map((proactive) => {
        const list = data.candidates.filter((c) => c.proactive === proactive);
        if (!list.length) return null;
        return (
          <section key={String(proactive)} className="candidate-section">
            {proactive && (
              <header className="section-head">
                <h2>Before it hurts</h2>
                <p className="muted small">Trends in monitoring and changes, and findings from external analysis: problems waiting to happen.</p>
              </header>
            )}
            <div className="candidates">
              {list.map((c) => (
                <CandidateCard key={c.key} c={c} editable={editable}
                  onCreate={() => setCreating(c)} onLink={() => setLinking(c)} onDecide={() => setDeciding(c)} onRestore={() => restore(c)} />
              ))}
            </div>
          </section>
        );
      })}
      {data && <RulesCard rules={data.rules} editable={isManager(user)} onSaved={reload} />}
      {creating && <CreateModal candidate={creating} onClose={() => setCreating(null)} />}
      {linking && <LinkModal candidate={linking} onClose={() => setLinking(null)} />}
      {deciding && <DecisionModal candidate={deciding} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); reload(); }} />}
    </>
  );
}

function CandidateCard({ c, editable, onCreate, onLink, onDecide, onRestore }: { c: Candidate; editable: boolean; onCreate: () => void; onLink: () => void; onDecide: () => void; onRestore: () => void }) {
  const ev = c.evidence;
  return (
    <article className="card candidate">
      <header>
        <div>
          <h2>
            {c.subject.type === 'incident' && c.subject.ref
              ? <Link to={`/incidents/${c.subject.ref}`} className="mono">{c.subject.ref}</Link>
              : <>{c.subject.name} {c.ci_ref && <Link to={`/cis/${c.ci_ref}`} className="mono small">{c.ci_ref}</Link>}</>}
          </h2>
          <span className="badge neutral">{c.rule_label}</span>
          {c.source && <span className="muted small"> from {c.source}</span>}
          {c.contains_personal_data && <span className="badge" title="The report holds personal data (personal identity numbers or email addresses). It is kept, and counts for AI handling.">Personal data</span>}
        </div>
        <span className="candidate-count" title={`${c.count} records`}>{c.count}</span>
      </header>
      <p className="candidate-reason">{c.reason}.</p>
      {ev.series?.map((s) => <DailyBars key={s.label} series={s} />)}
      {c.decision && (
        <p className="hint">
          {c.decision.decision === 'snoozed' ? `Snoozed until ${formatDate(c.decision.until!)}` : 'Dismissed'} by {c.decision.by ?? 'someone'} {relativeTime(c.decision.at)}: {c.decision.reason}
        </p>
      )}
      <details className="candidate-evidence">
        <summary>
          Evidence: {ev.total_records} record{ev.total_records === 1 ? '' : 's'}
          {ev.cis.length > 0 && <>, {ev.cis.length} CI{ev.cis.length === 1 ? '' : 's'}</>}
          {c.first_at && <span className="muted"> · first {relativeTime(c.first_at)}, latest {relativeTime(c.last_at!)}</span>}
        </summary>
        {ev.cis.length > 0 && (
          <ul className="chip-list candidate-cis">
            {ev.cis.map((x) => (
              <li key={`${x.role}${x.ref}`} className={x.role === 'upstream' ? 'upstream' : ''}>
                <Link to={`/cis/${x.ref}`}>{x.name}</Link> <span className="mono small muted">{x.ref}</span>
                {x.role === 'upstream' && <span className="badge neutral">shared dependency</span>}
              </li>
            ))}
          </ul>
        )}
        <ul className="record-list">
          {ev.records.map((r) => (
            <li key={r.key}>
              <span className={`kind kind-${r.kind}`}>{r.kind === 'external' ? 'finding' : r.kind}</span>
              {r.incident_ref ? <Link to={`/incidents/${r.incident_ref}`} className="mono">{r.reference}</Link>
                : r.change_ref ? <Link to={`/changes/${r.change_ref}`} className="mono">{r.reference}</Link>
                : r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer" className="mono">{r.reference}</a>
                : <span className="mono">{r.reference}</span>}
              <span className="record-summary">{r.summary}{r.note && <span className="muted"> · {r.note}</span>}</span>
              {r.occurred_at ? <time className="muted small" title={formatDate(r.occurred_at)}>{relativeTime(r.occurred_at)}</time> : <span />}
            </li>
          ))}
          {ev.total_records > ev.records.length && <li className="muted small">and {ev.total_records - ev.records.length} more</li>}
        </ul>
        {ev.notes && <p className="candidate-notes">{ev.notes}</p>}
      </details>
      {editable && (
        <div className="actions">
          {c.decision
            ? <button className="btn" onClick={onRestore}>Restore</button>
            : <>
                <button className="btn-link spacer-right" onClick={onDecide}>Dismiss or snooze</button>
                <button className="btn" onClick={onLink}>Link to existing problem</button>
                <button className="btn primary" onClick={onCreate}>Log problem</button>
              </>}
        </div>
      )}
    </article>
  );
}

/**
 * One value per day as thin bars, oldest first. Where two windows are compared, the earlier one is muted and the
 * current one carries the accent. Each bar has its value on hover; the summary is there for screen readers.
 */
function DailyBars({ series: s }: { series: Series }) {
  const max = Math.max(1, ...s.points.map((p) => p.value));
  const splitAt = s.split ? s.points.findIndex((p) => p.day === s.split) : -1;
  const sum = (from: number, to: number) => s.points.slice(from, to).reduce((t, p) => t + p.value, 0);
  const summary = splitAt > 0
    ? `${s.label}: ${sum(splitAt, s.points.length)} ${s.unit} in the last ${s.points.length - splitAt} days, ${sum(0, splitAt)} in the ${splitAt} days before`
    : `${s.label}: ${sum(0, s.points.length)} ${s.unit} in ${s.points.length} days, at most ${max} a day`;
  const W = 6, GAP = 2, H = 40;
  return (
    <figure className="daily-bars">
      <svg viewBox={`0 0 ${s.points.length * (W + GAP)} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary}>
        {s.points.map((p, i) => {
          const h = p.value ? Math.max(2, (p.value / max) * (H - 2)) : 0;
          return (
            <g key={p.day} className={splitAt > 0 && i < splitAt ? 'before' : 'now'}>
              <rect className="hit" x={i * (W + GAP)} y={0} width={W + GAP} height={H}><title>{`${p.day}: ${p.value} ${s.unit}`}</title></rect>
              {h > 0 && <rect className="bar" x={i * (W + GAP)} y={H - h} width={W} height={h} rx={1.5}><title>{`${p.day}: ${p.value} ${s.unit}`}</title></rect>}
            </g>
          );
        })}
        <line className="baseline" x1={0} x2={s.points.length * (W + GAP)} y1={H - 0.5} y2={H - 0.5} />
      </svg>
      <figcaption className="muted small">
        {s.label}, {s.points[0].day} – {s.points[s.points.length - 1].day}{splitAt > 0 && <> · <span className="legend-before">before</span> <span className="legend-now">last {s.points.length - splitAt} days</span></>}
      </figcaption>
    </figure>
  );
}

function RulesCard({ rules, editable, onSaved }: { rules: Rule[]; editable: boolean; onSaved: () => void }) {
  return (
    <details className="card candidate-rules">
      <summary><h2>How candidates are found</h2></summary>
      <ul>
        {rules.map((r) => <RuleRow key={r.rule} rule={r} editable={editable} onSaved={onSaved} />)}
      </ul>
    </details>
  );
}

function RuleRow({ rule, editable, onSaved }: { rule: Rule; editable: boolean; onSaved: () => void }) {
  const [form, setForm] = useState(rule);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setForm(rule), [rule]);
  const dirty = JSON.stringify(form) !== JSON.stringify(rule);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.put(`/api/candidates/rules/${rule.rule}`, { enabled: form.enabled, settings: form.settings });
      setError(null);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <li className={rule.enabled ? '' : 'inactive'}>
      <strong>{rule.label}</strong>{!rule.enabled && <span className="muted small"> (off)</span>}
      <p className="muted small">{describe(rule)}</p>
      {editable && (
        <form className="inline-form rule-form" onSubmit={save}>
          <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> On</label>
          {Object.entries(form.settings).map(([k, v]) => (
            <label key={k}>{SETTING_LABEL[k] ?? k}
              <input type="number" min={1} value={v} onChange={(e) => setForm({ ...form, settings: { ...form.settings, [k]: Number(e.target.value) } })} />
            </label>
          ))}
          {dirty && <button className="btn small primary">Save</button>}
          {error && <span className="error small">{error}</span>}
        </form>
      )}
    </li>
  );
}

const SNOOZE: [label: string, days: number][] = [['1 day', 1], ['1 week', 7], ['30 days', 30]];

function DecisionModal({ candidate: c, onClose, onDone }: { candidate: Candidate; onClose: () => void; onDone: () => void }) {
  const [snooze, setSnooze] = useState(0);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/candidates/dismiss', { key: c.key, reason, ...(snooze ? { until: new Date(Date.now() + snooze * 86_400_000).toISOString() } : {}) });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Dismiss or snooze" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <fieldset className="full radio-row">
          <label className="check"><input type="radio" checked={!snooze} onChange={() => setSnooze(0)} /> Dismiss</label>
          {SNOOZE.map(([label, d]) => <label key={d} className="check"><input type="radio" checked={snooze === d} onChange={() => setSnooze(d)} /> Snooze {label}</label>)}
        </fieldset>
        <p className="hint full">
          {snooze
            ? 'The candidate is hidden until then, whatever arrives meanwhile.'
            : `Dismissing covers the ${c.count} records it has now. It comes back only if new records are enough for the rule on their own.`}
        </p>
        <label className="full">Reason<textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this not a problem (yet)?" /></label>
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">{snooze ? 'Snooze' : 'Dismiss'}</button>
        </div>
      </form>
    </Modal>
  );
}

interface Draft { title: string; description: string; affected_service: string; detection: 'reactive' | 'proactive'; ci_refs: string[]; records: number }

function CreateModal({ candidate: c, onClose }: { candidate: Candidate; onClose: () => void }) {
  const navigate = useNavigate();
  const { meta } = useSession();
  const { data: draft, error: draftError } = useApi<Draft>(`/api/candidates/draft?${new URLSearchParams({ key: c.key })}`);
  const [form, setForm] = useState({ title: '', description: '', impact: 2, urgency: 2, category_id: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (draft) setForm((f) => ({ ...f, title: draft.title, description: draft.description }));
  }, [draft]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await api.post<ProblemDetail>('/api/candidates/create', {
        key: c.key,
        problem: { ...form, category_id: form.category_id ? Number(form.category_id) : null },
      });
      navigate(`/problems/${p.ref}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Log problem from candidate" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint full">
          {draft
            ? <>The {draft.records} records{draft.ci_refs.length ? ` and ${draft.ci_refs.length} CI${draft.ci_refs.length === 1 ? '' : 's'}` : ''} are linked to the new problem, logged as {draft.detection === 'reactive' ? 'reactively' : 'proactively'} identified.</>
            : 'Preparing the problem from the evidence…'}
        </p>
        <label className="full">Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label className="full">Description<textarea rows={8} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
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
        {(error || draftError) && <div className="error full">{error ?? draftError}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!draft}>Log problem</button>
        </div>
      </form>
    </Modal>
  );
}

function LinkModal({ candidate: c, onClose }: { candidate: Candidate; onClose: () => void }) {
  const navigate = useNavigate();
  const [ref, setRef] = useState('');
  const q = c.subject.type === 'incident' ? '' : c.subject.name;
  const { data: open } = useApi<{ ref: string; title: string }[]>(`/api/problems?${new URLSearchParams({ q })}`);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await api.post<ProblemDetail>('/api/candidates/link', { ref, key: c.key });
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
        {open && open.length > 0 && q && (
          <div className="full suggestions">
            <span className="muted small">Open problems mentioning {q}:</span>
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
