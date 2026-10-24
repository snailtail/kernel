import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../../api/client';
import { useApi } from '../../../hooks';
import type { CandidateRule, EolVersion } from '../../../api/types/candidates';
import '../styles.css';

const SETTING_LABEL: Record<string, string> = {
  min_records: 'At least (records)', min_cis: 'On at least (CIs)', window_days: 'Within (days)', max_depth: 'Dependency steps',
  min_flaps: 'At least (reopenings)', min_events: 'At least (events)', factor_percent: 'Growth (%)', min_firings: 'At least (firings)',
  min_times: 'At least (times)', warn_days: 'Warn ahead (days)', min_services: 'At least (services)',
  max_minutes: 'Cleared within (min)', min_changes: 'At least (changes)', min_percent: 'Bad (%)', within_hours: 'Incident within (hours)',
};
/** The rule's description with its current values filled in, for people who cannot change it. */
const describe = (r: CandidateRule) => r.description.replace(/\b[a-z]+_[a-z_]+\b/g, (k) => (k in r.settings ? String(r.settings[k]) : k));

export function RulesCard({ rules, editable, onSaved }: { rules: CandidateRule[]; editable: boolean; onSaved: () => void }) {
  return (
    <details className="card candidate-rules">
      <summary><h2>How candidates are found</h2></summary>
      <ul>
        {rules.map((r) => <RuleRow key={r.rule} rule={r} editable={editable} onSaved={onSaved} />)}
      </ul>
    </details>
  );
}

function RuleRow({ rule, editable, onSaved }: { rule: CandidateRule; editable: boolean; onSaved: () => void }) {
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
      {rule.error && <span className="error small"> · {rule.error}</span>}
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
      {rule.rule === 'eol_versions' && <EolTable editable={editable} onSaved={onSaved} />}
    </li>
  );
}

/** The end-of-life table behind the rule: product + version → date, kept by hand (no outside service). */
function EolTable({ editable, onSaved }: { editable: boolean; onSaved: () => void }) {
  const { data, reload } = useApi<EolVersion[]>('/api/candidates/eol');
  const blank = { product: '', version: '', eol_date: '', note: '' };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const done = () => { setError(null); reload(); onSaved(); };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/candidates/eol', form);
      setForm(blank);
      done();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (row: EolVersion) => {
    if (!confirm(`Remove ${row.product} ${row.version} from the table?`)) return;
    try {
      await api.del(`/api/candidates/eol/${row.id}`);
      done();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="eol-table">
      <table className="table compact">
        <thead><tr><th>Product</th><th>Version</th><th>End of life</th><th>Note</th>{editable && <th />}</tr></thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id}>
              <td>{r.product}</td><td>{r.version}</td>
              <td className={r.eol_date < today ? 'eol-passed' : ''}>{r.eol_date}</td>
              <td className="muted">{r.note}</td>
              {editable && <td><button className="btn-link small" onClick={() => remove(r)} aria-label={`Remove ${r.product} ${r.version}`}>Remove</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {editable && (
        <form className="inline-form rule-form" onSubmit={add}>
          <label>Product<input required value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} placeholder="Ubuntu" /></label>
          <label>Version<input required value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="20.04" /></label>
          <label>End of life<input required type="date" value={form.eol_date} onChange={(e) => setForm({ ...form, eol_date: e.target.value })} /></label>
          <label>Note<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="End of standard support" /></label>
          <button className="btn small primary">Add</button>
          {error && <span className="error small">{error}</span>}
        </form>
      )}
    </div>
  );
}
