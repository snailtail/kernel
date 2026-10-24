import { type EditorProps, replaceAt, removeAt } from './common';
import '../../styles.css';

export function FiveWhys({ data, set, readOnly }: EditorProps) {
  const whys: { why: string; because: string; evidence?: string; assumption?: boolean }[] = data.whys ?? [];
  return (
    <div className="five-whys">
      <label>Problem statement
        <input value={data.problem_statement ?? ''} readOnly={readOnly} onChange={(e) => set({ ...data, problem_statement: e.target.value })} placeholder="What exactly goes wrong, where and when?" />
      </label>
      <ol className="why-chain">
        {whys.map((w, i) => (
          <li key={i}>
            <span className="why-n">{i + 1}</span>
            <div className="why-fields">
              <input value={w.why} readOnly={readOnly} placeholder={i === 0 ? 'Why does this happen?' : 'Why?'} onChange={(e) => set({ ...data, whys: replaceAt(whys, i, { ...w, why: e.target.value }) })} />
              <input value={w.because} readOnly={readOnly} placeholder="Because…" onChange={(e) => set({ ...data, whys: replaceAt(whys, i, { ...w, because: e.target.value }) })} />
              <input className="why-evidence" value={w.evidence ?? ''} readOnly={readOnly || !!w.assumption} placeholder={w.assumption ? 'Assumption – verify with an action' : 'Evidence: log line, metric, change ref…'} onChange={(e) => set({ ...data, whys: replaceAt(whys, i, { ...w, evidence: e.target.value }) })} />
              <label className="check small"><input type="checkbox" disabled={readOnly} checked={!!w.assumption} onChange={(e) => set({ ...data, whys: replaceAt(whys, i, { ...w, assumption: e.target.checked }) })} /> Assumption</label>
            </div>
            {!readOnly && <button className="btn-icon small" aria-label="Remove step" onClick={() => set({ ...data, whys: removeAt(whys, i) })}>×</button>}
          </li>
        ))}
      </ol>
      {!readOnly && <button className="btn-link small" onClick={() => set({ ...data, whys: [...whys, { why: '', because: '', evidence: '', assumption: false }] })}>+ Ask why</button>}
      <label className="stop-question">Is the last cause within our control?
        <select disabled={readOnly} value={data.root_cause_in_control === true ? 'yes' : data.root_cause_in_control === false ? 'no' : ''} onChange={(e) => set({ ...data, root_cause_in_control: e.target.value === '' ? null : e.target.value === 'yes' })}>
          <option value="">Not decided</option>
          <option value="yes">Yes – removing it prevents recurrence</option>
          <option value="no">No – keep asking why it can affect us</option>
        </select>
      </label>
    </div>
  );
}
