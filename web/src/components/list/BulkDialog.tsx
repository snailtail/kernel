import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../../api/client';
import { applyUndo, previewUndo, runBulk, storms, type BulkResult, type ItemResult, type OpName, type Operation } from '../../bulk';
import { CLOSURE_LABEL } from '../../format';
import { useSession } from '../../session';
import { INCIDENT_RESOLUTION } from '../../statuses';
import { Modal } from '../Modal';
import { useTeams } from '../Teams';
import { OP_LABEL, UNDO_SECONDS, type BulkSpec } from './bulk';

// A bulk change is previewed, applied in chunks, reported per record and can be undone for 30 seconds.

export function UndoToast({ toast, spec, onDone }: { toast: { text: string; undo: BulkResult['undo']; until: number }; spec: BulkSpec; onDone: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Teams the undo would page more than once: shown, and confirmed, before anything is sent.
  const [confirm, setConfirm] = useState<{ team: string; count: number }[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((toast.until - now) / 1000));
  useEffect(() => {
    if (left === 0 && !busy && !confirm && !error) onDone();
  }, [left, busy, confirm, error, onDone]);
  const run = async (confirmPaging: boolean) => {
    if (!toast.undo) return;
    setBusy(true);
    setError(null);
    try {
      if (!confirmPaging) {
        const many = storms(await previewUndo(api.post, spec.practice, toast.undo));
        if (many.length) {
          setConfirm(many);
          setBusy(false);
          return;
        }
      }
      const r = await applyUndo(api.post, spec.practice, toast.undo, confirmPaging);
      if (r.error) {
        setError(`Undone for ${r.summary.changed ?? 0} of ${toast.undo.items.length}: ${r.error}`);
        setBusy(false);
      } else onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="bulk-toast" role="status">
      <span>{toast.text}</span>
      {toast.undo && !confirm && <button className="btn small" disabled={busy || left === 0} onClick={() => run(false)}>Undo ({left}s)</button>}
      {confirm && (
        <>
          <label className="check small"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Undo pages {confirm.map((p) => `${p.team} ${p.count} times`).join(' and ')}</label>
          <button className="btn small" disabled={!confirmed || busy} onClick={() => run(true)}>Undo anyway</button>
        </>
      )}
      {error && <span className="error small">{error}</span>}
      <button className="btn-link small" aria-label="Dismiss" onClick={onDone}>×</button>
    </div>
  );
}

/** "will be assigned to Network", "will move to Resolved"… */
function describe(spec: BulkSpec, operation: Operation, people: Map<number, string>, teams: Map<number, string>) {
  switch (operation.op) {
    case 'assign': {
      const parts: string[] = [];
      if (operation.team_id !== undefined) parts.push(operation.team_id === null ? 'no team' : `team ${teams.get(operation.team_id as number) ?? operation.team_id}`);
      if (operation.assignee_id !== undefined) parts.push(operation.assignee_id === null ? 'nobody' : people.get(operation.assignee_id as number) ?? 'the person chosen');
      return `will be assigned to ${parts.join(' and ')}`;
    }
    case 'status': return `will move to ${spec.statuses?.[operation.to as string] ?? operation.to}`;
    case 'priority': return `will get ${[operation.impact && `impact ${operation.impact}`, operation.urgency && `urgency ${operation.urgency}`].filter(Boolean).join(' and ')}`;
    case 'tags': return `will get tags ${[...(operation.add as string[]).map((t) => `+${t}`), ...(operation.remove as string[]).map((t) => `−${t}`)].join(' ')}`;
    case 'link_problem': return operation.problem ? `will be linked to ${operation.problem}` : 'will be unlinked from their problem';
    case 'set_parent': return `will be related to ${operation.parent}`;
    case 'acknowledge': return 'will be acknowledged';
    case 'close': return 'will be closed';
  }
}

export function BulkDialog({ spec, op, ids, filter, onClose, onApplied }: {
  spec: BulkSpec; op: OpName; ids: string[] | null; filter: string; onClose: () => void; onApplied: (r: BulkResult, text: string) => void;
}) {
  const { meta } = useSession();
  const teams = useTeams();
  const [form, setForm] = useState<Record<string, string>>({ assignee: 'keep', team: 'keep', impact: '', urgency: '', to: '', add: '', remove: '', ref: '' });
  const [preview, setPreview] = useState<{ operation: Operation; result: BulkResult; ids: string[] } | null>(null);
  const [confirmPaging, setConfirmPaging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const people = new Map(meta.assignees.map((a) => [a.id, a.display_name]));
  const teamNames = new Map(teams.map((t) => [t.id, t.name]));
  const owner = spec.owner === 'owner' ? 'Owner' : 'Assignee';

  const operation = (): Operation | string => {
    switch (op) {
      case 'assign': {
        const o: Operation = { op };
        if (form.assignee !== 'keep') o.assignee_id = form.assignee === 'none' ? null : Number(form.assignee);
        if (spec.teams && form.team !== 'keep') o.team_id = form.team === 'none' ? null : Number(form.team);
        return Object.keys(o).length > 1 ? o : `Choose ${spec.teams ? 'a team or a person' : 'an owner'}`;
      }
      case 'status': {
        if (!form.to) return 'Choose the status';
        const details: Record<string, string> = {};
        for (const k of ['comment', 'resolution_code', 'resolution', 'hold_reason', 'closure_code', 'root_cause', 'cancel_reason', 'note', 'reason']) if (form[k]?.trim()) details[k] = form[k].trim();
        return { op, to: form.to, details };
      }
      case 'priority': {
        if (!form.impact && !form.urgency) return 'Choose impact or urgency';
        return { op, ...(form.impact ? { impact: Number(form.impact) } : {}), ...(form.urgency ? { urgency: Number(form.urgency) } : {}) };
      }
      case 'tags': {
        const split = (s: string) => s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
        return split(form.add).length || split(form.remove).length ? { op, add: split(form.add), remove: split(form.remove) } : 'Give tags to add or remove';
      }
      case 'link_problem': return form.ref.trim() || form.unlink ? { op, problem: form.unlink ? null : form.ref.trim().toUpperCase() } : 'Give the problem, e.g. PRB000012';
      case 'set_parent': return form.ref.trim() ? { op, parent: form.ref.trim().toUpperCase() } : 'Give the incident to relate them to';
      default: return { op };
    }
  };

  const doPreview = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const o = operation();
    if (typeof o === 'string') return setError(o);
    try {
      // "All matching": the server resolves the filter once; the preview lists the records, which are then applied by id.
      const result = ids
        ? await runBulk(api.post, spec.practice, { ids }, { operation: o, dry_run: true })
        : await api.post<BulkResult>(`/api/${spec.practice}/bulk`, { filter, operation: o, dry_run: true });
      if (result.error) throw new Error(result.error);
      setPreview({ operation: o, result, ids: result.results.filter((r) => r.outcome === 'would_change').map((r) => r.id) });
      setConfirmPaging(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setError(null);
    setProgress(0);
    const result = await runBulk(api.post, spec.practice, { ids: preview.ids }, { operation: preview.operation, confirm_paging: confirmPaging }, setProgress);
    setProgress(null);
    // Nothing went through: stay on the preview with the reason. Otherwise show what was done, and keep its undo.
    if (result.error && !result.sent) setError(result.error);
    else setDone(result);
  };

  const noun = (n: number) => `${n} ${n === 1 ? spec.noun[0] : spec.noun[1]}`;
  const storm = preview?.result.pages.filter((p) => p.count > 1) ?? [];
  const problems = (r: BulkResult) => r.results.filter((x) => x.outcome === 'skipped' || x.outcome === 'failed');

  if (done) {
    const changed = done.summary.changed ?? 0;
    const text = `${noun(changed)} ${describe(spec, preview!.operation, people, teamNames).replace(/^will be /, '').replace(/^will /, '')}`;
    return (
      <Modal title={OP_LABEL[op]} onClose={() => onApplied(done, text)}>
        <div className="form">
          {done.error && <div className="error full" role="alert">Applied to {done.sent} of {preview!.ids.length}, then stopped: {done.error}</div>}
          <p className="full"><strong>{noun(changed)}</strong> changed{done.summary.unchanged ? `, ${done.summary.unchanged} already so` : ''}.</p>
          {done.pages.length > 0 && <p className="full hint">Paged: {done.pages.map((p) => `${p.team} (${p.count})`).join(', ')}.</p>}
          <Outcomes items={problems(done)} done />
          <div className="actions full">
            <button className="btn primary" onClick={() => onApplied(done, text)}>Done{done.undo ? ` (undo for ${UNDO_SECONDS}s)` : ''}</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`${OP_LABEL[op]}: ${ids ? noun(ids.length) : `all matching ${spec.noun[1]}`}`} onClose={onClose}>
      {!preview ? (
        <form className="form" onSubmit={doPreview}>
          {op === 'assign' && (
            <>
              {spec.teams && (
                <label>Team
                  <select value={form.team} onChange={set('team')}>
                    <option value="keep">Keep as is</option><option value="none">No team</option>
                    {teams.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
              )}
              <label>{owner}
                <select value={form.assignee} onChange={set('assignee')}>
                  <option value="keep">Keep as is</option><option value="none">Nobody</option>
                  {meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
                </select>
              </label>
            </>
          )}
          {op === 'status' && (
            <>
              <label className="full">New status
                <select value={form.to} onChange={set('to')} autoFocus>
                  <option value="">Choose…</option>
                  {Object.entries(spec.statuses ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              {spec.practice === 'incidents' && form.to === 'resolved' && (
                <>
                  <label>Resolution code
                    <select value={form.resolution_code ?? ''} onChange={set('resolution_code')}>
                      <option value="">Choose…</option>{Object.entries(INCIDENT_RESOLUTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                  <label className="full">How service was restored<textarea rows={2} value={form.resolution ?? ''} onChange={set('resolution')} /></label>
                </>
              )}
              {spec.practice === 'incidents' && form.to === 'on_hold' && <label className="full">Why on hold<input value={form.hold_reason ?? ''} onChange={set('hold_reason')} /></label>}
              {spec.practice === 'problems' && form.to === 'closed' && (
                <label>Closure code
                  <select value={form.closure_code ?? ''} onChange={set('closure_code')}>
                    <option value="">Choose…</option>{meta.closure_codes.map((c) => <option key={c} value={c}>{CLOSURE_LABEL[c] ?? c}</option>)}
                  </select>
                </label>
              )}
              {spec.practice === 'problems' && form.to === 'resolved' && <label className="full">Resolution<textarea rows={2} value={form.resolution ?? ''} onChange={set('resolution')} /></label>}
              {spec.practice === 'changes' && form.to === 'cancelled' && <label className="full">Why cancelled<input value={form.cancel_reason ?? ''} onChange={set('cancel_reason')} /></label>}
              {spec.practice === 'requests' && form.to === 'cancelled' && <label className="full">Why cancelled<input value={form.reason ?? ''} onChange={set('reason')} /></label>}
              {spec.practice === 'articles'
                ? <label className="full">Note <span className="muted small">(optional)</span><input value={form.note ?? ''} onChange={set('note')} /></label>
                : spec.practice !== 'actions' && <label className="full">Comment <span className="muted small">(optional, on each record)</span><input value={form.comment ?? ''} onChange={set('comment')} /></label>}
            </>
          )}
          {op === 'priority' && (
            <>
              <label>Impact<select value={form.impact} onChange={set('impact')}><option value="">Keep</option><option value="1">1 High</option><option value="2">2 Medium</option><option value="3">3 Low</option></select></label>
              <label>Urgency<select value={form.urgency} onChange={set('urgency')}><option value="">Keep</option><option value="1">1 High</option><option value="2">2 Medium</option><option value="3">3 Low</option></select></label>
            </>
          )}
          {op === 'tags' && (
            <>
              <label>Add tags<input value={form.add} onChange={set('add')} placeholder="edge, legacy" /></label>
              <label>Remove tags<input value={form.remove} onChange={set('remove')} /></label>
            </>
          )}
          {op === 'link_problem' && (
            <>
              <label>Problem<input value={form.ref} onChange={set('ref')} placeholder="PRB000012" disabled={!!form.unlink} /></label>
              <label className="check"><input type="checkbox" checked={!!form.unlink} onChange={(e) => setForm({ ...form, unlink: e.target.checked ? '1' : '' })} /> Unlink from their problem instead</label>
            </>
          )}
          {op === 'set_parent' && <label className="full">The incident they are part of<input value={form.ref} onChange={set('ref')} placeholder="INC000123" /></label>}
          {(op === 'acknowledge' || op === 'close') && <p className="hint full">{op === 'close' ? 'Closes the alerts by hand. A new event for the same check opens it again.' : 'Shows the others that someone is looking at these alerts.'}</p>}
          {error && <div className="error full" role="alert">{error}</div>}
          <div className="actions full">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary">Preview</button>
          </div>
        </form>
      ) : (
        <div className="form">
          {preview.ids.length ? (
            <p className="full bulk-preview">
              <strong>{noun(preview.ids.length)}</strong> {describe(spec, preview.operation, people, teamNames)}.
              {preview.result.summary.unchanged ? ` ${preview.result.summary.unchanged} already ${preview.result.summary.unchanged === 1 ? 'is' : 'are'}.` : ''}
            </p>
          ) : (
            <p className="full bulk-preview">Nothing to change{preview.result.summary.unchanged ? `: ${preview.result.summary.unchanged === 1 ? 'it already is' : `all ${preview.result.summary.unchanged} already are`}` : ''}.</p>
          )}
          <Outcomes items={problems(preview.result)} />
          {preview.result.pages.length > 0 && (
            <div className={`full ${storm.length ? 'warn-box' : 'hint'}`}>
              <p>This pages on-call: {preview.result.pages.map((p) => `${p.team} ${p.count === 1 ? 'once' : `${p.count} times`}`).join(', ')}.</p>
              {storm.length > 0 && (
                <label className="check"><input type="checkbox" checked={confirmPaging} onChange={(e) => setConfirmPaging(e.target.checked)} /> Yes, page {storm.map((p) => `${p.team} ${p.count} times`).join(' and ')}</label>
              )}
            </div>
          )}
          {progress !== null && <progress className="full" max={preview.ids.length} value={progress}>{progress} of {preview.ids.length}</progress>}
          {error && <div className="error full" role="alert">{error}</div>}
          <div className="actions full">
            <button className="btn" onClick={() => setPreview(null)} disabled={progress !== null}>Back</button>
            {preview.ids.length > 0 && (
              <button className="btn primary" onClick={apply} disabled={progress !== null || (storm.length > 0 && !confirmPaging)}>
                {progress !== null ? `Applying ${progress}/${preview.ids.length}…` : `Apply to ${noun(preview.ids.length)}`}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Outcomes({ items, done }: { items: ItemResult[]; done?: boolean }): ReactNode {
  if (!items.length) return null;
  return (
    <details className="full bulk-outcomes" open={items.length <= 5}>
      <summary>{items.length} {done ? 'not changed' : 'will not change'}</summary>
      <ul>
        {items.map((r) => (
          <li key={r.id}><span className="mono">{r.id}</span> {r.title && <span className="muted">{r.title}</span>} – {r.reason ?? r.outcome}</li>
        ))}
      </ul>
    </details>
  );
}
