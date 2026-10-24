import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import type { Change } from '../../../api/types/changes';
import { OUTCOME } from '../common';

export function FinishChange({ change: c, to, onClose, onDone }: { change: Change; to: 'review' | 'closed'; onClose: () => void; onDone: (c: Change) => void }) {
  // Linked deployments may suggest an outcome (#32): preselected, but the person decides.
  const suggestion = c.next_steps.steps.find((s) => s.id === 'implement')?.suggestion;
  const [outcome, setOutcome] = useState(c.outcome ?? suggestion?.outcome ?? 'successful');
  const [review, setReview] = useState(c.review);
  const needsReview = to === 'closed' && (c.outcome !== 'successful' || c.change_type === 'emergency');
  return (
    <FormModal title={to === 'review' ? 'Record the outcome' : 'Close the change'} submitLabel={to === 'review' ? 'Record' : 'Close'} onClose={onClose}
      onSubmit={async () => onDone(await api.post<Change>(`/api/changes/${c.ref}/transition`, to === 'review' ? { to, outcome } : { to, review }))}>
      {to === 'review' ? (
        <>
          <label className="full">Outcome<select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{Object.entries(OUTCOME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {suggestion?.outcome && <p className="hint full small">Suggested from the linked work: {suggestion.reason}.</p>}
        </>
      ) : (
        <label className="full">Post-implementation review {needsReview ? <span className="muted small">(required)</span> : <span className="muted small">(optional)</span>}
          <textarea rows={5} required={needsReview} placeholder="What happened, what went well, what to improve" value={review} onChange={(e) => setReview(e.target.value)} />
        </label>
      )}
    </FormModal>
  );
}
