import { useState } from 'react';
import { api, type ProblemDetail } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { DECISION_LABEL, EFFECTIVENESS_LABEL, RISK_LABEL } from '../../../format';
import { isManager, useSession } from '../../../session';

export function AssessmentModal({ problem: p, onClose, onDone }: { problem: ProblemDetail; onClose: () => void; onDone: (p: ProblemDetail) => void }) {
  const { user, meta } = useSession();
  const [form, setForm] = useState({
    ec_risk_level: p.ec_risk_level ? String(p.ec_risk_level) : '',
    ec_risk: p.ec_risk,
    ec_fix_cost: p.ec_fix_cost,
    ec_decision: p.ec_decision ?? '',
    ec_decision_note: p.ec_decision_note,
    ec_review_date: p.ec_review_date ?? '',
    workaround_effectiveness: p.workaround_effectiveness ?? '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async () => {
    onDone(await api.put<ProblemDetail>(`/api/problems/${p.ref}/assessment`, {
      ...form,
      ec_risk_level: form.ec_risk_level ? Number(form.ec_risk_level) : null,
      ec_decision: form.ec_decision || null,
      ec_review_date: form.ec_review_date || null,
      workaround_effectiveness: form.workaround_effectiveness || null,
    }));
  };
  const managerOnly = (d: string) => (d === 'accept' || d === 'defer') && !isManager(user);
  return (
    <FormModal title={`Error control – ${p.ref}`} submitLabel="Save assessment" onClose={onClose} onSubmit={submit}>
      <p className="hint full">Weigh the risk of living with this known error against the cost of a permanent fix. Accepting or deferring the risk is a decision for a manager.</p>
      <label>Risk of not fixing
        <select value={form.ec_risk_level} onChange={set('ec_risk_level')}>
          <option value="">Not assessed</option>
          {[1, 2, 3].map((l) => <option key={l} value={l}>{RISK_LABEL[l]}</option>)}
        </select>
      </label>
      <label>Workaround
        <select value={form.workaround_effectiveness} onChange={set('workaround_effectiveness')}>
          <option value="">Not reviewed</option>
          {meta.workaround_effectiveness.map((w) => <option key={w} value={w}>{EFFECTIVENESS_LABEL[w]}</option>)}
        </select>
      </label>
      <label className="full">Risk and impact if it recurs
        <textarea rows={3} value={form.ec_risk} onChange={set('ec_risk')} placeholder="How often, how many users, cost of applying the workaround each time" />
      </label>
      <label className="full">Cost of a permanent fix
        <textarea rows={3} value={form.ec_fix_cost} onChange={set('ec_fix_cost')} placeholder="Effort, vendor dependency, change risk" />
      </label>
      <label>Decision
        <select value={form.ec_decision} onChange={set('ec_decision')}>
          <option value="">–</option>
          {meta.ec_decisions.map((d) => <option key={d} value={d} disabled={managerOnly(d)}>{DECISION_LABEL[d]}{managerOnly(d) ? ' (managers)' : ''}</option>)}
        </select>
      </label>
      <label>Review date
        <input type="date" value={form.ec_review_date} onChange={set('ec_review_date')} />
      </label>
      <label className="full">Rationale
        <textarea rows={3} value={form.ec_decision_note} onChange={set('ec_decision_note')} />
      </label>
    </FormModal>
  );
}
