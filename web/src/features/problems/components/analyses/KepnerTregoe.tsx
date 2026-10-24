import { type EditorProps, replaceAt, removeAt } from './common';

const KT_DIMENSIONS = [
  ['what', 'What', 'Which object or system, what defect?'],
  ['where', 'Where', 'Where is it observed: location, component, environment?'],
  ['when', 'When', 'When did it start, when does it occur, in what pattern?'],
  ['extent', 'Extent', 'How many, how big, is it growing?'],
] as const;

export function KepnerTregoe({ data, set, readOnly }: EditorProps) {
  const causes: { cause: string; test: string; result: string }[] = data.possible_causes ?? [];
  const field = (dim: string, key: 'is' | 'is_not' | 'distinction') => (
    <textarea
      rows={2}
      readOnly={readOnly}
      value={data[dim]?.[key] ?? ''}
      onChange={(e) => set({ ...data, [dim]: { ...data[dim], [key]: e.target.value } })}
    />
  );
  return (
    <div className="kt">
      <label>Problem statement
        <input value={data.problem_statement ?? ''} readOnly={readOnly} onChange={(e) => set({ ...data, problem_statement: e.target.value })} placeholder="Object + deviation, e.g. Order API returns 504" />
      </label>
      <div className="table-wrap">
        <table className="kt-table">
          <thead><tr><th /><th>IS</th><th>IS NOT</th><th>Distinction</th></tr></thead>
          <tbody>
            {KT_DIMENSIONS.map(([dim, label, hint]) => (
              <tr key={dim}>
                <th title={hint}>{label}</th>
                <td>{field(dim, 'is')}</td>
                <td>{field(dim, 'is_not')}</td>
                <td>{field(dim, 'distinction')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label>Changes related to the distinctions
        <textarea rows={2} readOnly={readOnly} value={data.changes ?? ''} onChange={(e) => set({ ...data, changes: e.target.value })} />
      </label>
      <div>
        <h4>Possible causes</h4>
        <ul className="kt-causes">
          {causes.map((c, i) => (
            <li key={i}>
              <input value={c.cause} readOnly={readOnly} placeholder="Possible cause" onChange={(e) => set({ ...data, possible_causes: replaceAt(causes, i, { ...c, cause: e.target.value }) })} />
              <input value={c.test} readOnly={readOnly} placeholder="Does it explain both IS and IS NOT?" onChange={(e) => set({ ...data, possible_causes: replaceAt(causes, i, { ...c, test: e.target.value }) })} />
              <select value={c.result} disabled={readOnly} className={`kt-result ${c.result}`} onChange={(e) => set({ ...data, possible_causes: replaceAt(causes, i, { ...c, result: e.target.value }) })}>
                <option value="untested">Untested</option>
                <option value="explains">Explains</option>
                <option value="does_not_explain">Does not explain</option>
              </select>
              {!readOnly && <button className="btn-icon small" aria-label="Remove cause" onClick={() => set({ ...data, possible_causes: removeAt(causes, i) })}>×</button>}
            </li>
          ))}
        </ul>
        {!readOnly && <button className="btn-link small" onClick={() => set({ ...data, possible_causes: [...causes, { cause: '', test: '', result: 'untested' }] })}>+ Possible cause</button>}
      </div>
    </div>
  );
}
