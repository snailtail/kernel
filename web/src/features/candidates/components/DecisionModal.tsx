import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import type { CandidateRuleId, Candidate } from '../../../api/types/candidates';
import '../styles.css';

/** Trend rules: what has to join before a dismissed candidate comes back. */
const TREND_JOINS: Partial<Record<CandidateRuleId, string>> = { flapping: 'alert', rising_warnings: 'alert', capacity_warnings: 'alert', self_clearing: 'alert', change_correlation: 'change', eol_versions: 'CI on that version' };

const SNOOZE: [label: string, days: number][] = [['1 day', 1], ['1 week', 7], ['30 days', 30]];

export function DecisionModal({ candidate: c, onClose, onDone }: { candidate: Candidate; onClose: () => void; onDone: () => void }) {
  const [snooze, setSnooze] = useState(0);
  const [reason, setReason] = useState('');
  const submit = async () => {
    await api.post('/api/candidates/dismiss', { key: c.key, reason, ...(snooze ? { until: new Date(Date.now() + snooze * 86_400_000).toISOString() } : {}) });
    onDone();
  };
  return (
    <FormModal title="Dismiss or snooze" submitLabel={snooze ? 'Snooze' : 'Dismiss'} onClose={onClose} onSubmit={submit}>
      <fieldset className="full radio-row">
        <label className="check"><input type="radio" checked={!snooze} onChange={() => setSnooze(0)} /> Dismiss</label>
        {SNOOZE.map(([label, d]) => <label key={d} className="check"><input type="radio" checked={snooze === d} onChange={() => setSnooze(d)} /> Snooze {label}</label>)}
      </fieldset>
      <p className="hint full">
        {snooze
          ? 'The candidate is hidden until then, whatever arrives meanwhile.'
          : TREND_JOINS[c.rule]
            ? `Dismissed until a new ${TREND_JOINS[c.rule]} joins; use Snooze to look again later.`
            : `Dismissing covers the ${c.count} records it has now. It comes back only if new records are enough for the rule on their own.`}
      </p>
      <label className="full">Reason<textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this not a problem (yet)?" /></label>
    </FormModal>
  );
}
