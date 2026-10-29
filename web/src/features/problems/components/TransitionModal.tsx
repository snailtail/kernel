import { useState } from 'react';
import { api, type ProblemDetail, type Status } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { CLOSURE_LABEL } from '../../../format';
import { useSession } from '../../../session';
import { PROBLEM_LIFECYCLE, TRANSITION_LABEL } from '../../../statuses';

/** The resolution a deployed fix suggests (#167): the change and the bugs it shipped. */
const fixedBy = (p: ProblemDetail) => {
  if (!p.fix?.deployed) return '';
  const bugs = (p.work_items ?? []).filter((w) => w.status === 'done').map((w) => w.ref);
  return `Fixed in ${p.fix.deployed.change}${bugs.length ? ` (${bugs.join(', ')})` : ''}, deployed ${p.fix.deployed.at.slice(0, 10)}.`;
};

export function TransitionModal({ problem: p, to, onClose, onDone }: { problem: ProblemDetail; to: Status; onClose: () => void; onDone: (p: ProblemDetail) => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({
    root_cause: p.root_cause,
    workaround: p.workaround,
    resolution: p.resolution || fixedBy(p),
    major_review: p.major_review,
    closure_code: to === 'closed' ? (p.status === 'resolved' ? 'resolved' : p.status === 'new' ? 'duplicate' : '') : '',
    comment: '',
  });
  const [acknowledge, setAcknowledge] = useState(false);
  const openActions = p.actions.filter((a) => a.status === 'open').length;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const reopen = PROBLEM_LIFECYCLE.indexOf(to) < PROBLEM_LIFECYCLE.indexOf(p.status);

  const submit = async () => {
    const body: Record<string, unknown> = { to, comment: form.comment || undefined };
    if (to === 'known_error') Object.assign(body, { root_cause: form.root_cause, workaround: form.workaround });
    if (to === 'resolved') Object.assign(body, { resolution: form.resolution });
    if (to === 'closed') {
      Object.assign(body, { closure_code: form.closure_code || undefined, acknowledge_open_actions: acknowledge || undefined });
      if (p.is_major) body.major_review = form.major_review;
    }
    onDone(await api.post<ProblemDetail>(`/api/problems/${p.ref}/transition`, body));
  };

  const title = reopen ? 'Reopen analysis' : TRANSITION_LABEL[to];
  return (
    <FormModal title={`${title} – ${p.ref}`} submitLabel={title} onClose={onClose} onSubmit={submit}>
      {to === 'known_error' && (
        <>
          <p className="hint full">Error control: the problem has been analysed. Document the root cause and any workaround so it is available in the known error database.</p>
          <label className="full">Root cause <span className="req">required</span><textarea required rows={5} value={form.root_cause} onChange={set('root_cause')} /></label>
          <label className="full">Workaround<textarea rows={4} value={form.workaround} onChange={set('workaround')} /></label>
        </>
      )}
      {to === 'resolved' && (
        <label className="full">Resolution <span className="req">required</span>
          <textarea required rows={5} value={form.resolution} onChange={set('resolution')} placeholder="The permanent solution. Link the implementing change under Linked records." />
        </label>
      )}
      {to === 'closed' && (
        <>
          <label className="full">Closure code <span className="req">required</span>
            <select required value={form.closure_code} onChange={set('closure_code')}>
              <option value="">Choose…</option>
              {meta.closure_codes.map((c) => <option key={c} value={c}>{CLOSURE_LABEL[c]}</option>)}
            </select>
          </label>
          {form.closure_code === 'no_fix' && p.ec_decision !== 'accept' && (
            <p className="warn-box full">Closing without a fix requires an accepted risk. Record the decision under Error control first.</p>
          )}
          {p.is_major && form.closure_code !== 'duplicate' && form.closure_code !== 'cancelled' && (
            <label className="full">Major problem review <span className="req">required</span>
              <textarea required rows={6} value={form.major_review} onChange={set('major_review')}
                placeholder="What went well, what could be improved, how to prevent recurrence, follow-up actions" />
            </label>
          )}
          {openActions > 0 && (
            <label className="check full warn-box">
              <input type="checkbox" required checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
              {openActions} follow-up action{openActions > 1 ? 's are' : ' is'} still open. Close the problem anyway.
            </label>
          )}
        </>
      )}
      <label className="full">
        {reopen ? 'Reason for reopening' : 'Comment'}
        <textarea rows={3} value={form.comment} onChange={set('comment')} required={reopen} />
      </label>
    </FormModal>
  );
}
