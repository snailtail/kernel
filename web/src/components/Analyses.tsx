import { useEffect, useState } from 'react';
import { api, asConflict, type Analysis, type Conflict, type ProblemDetail, type Technique } from '../api';
import { relativeTime } from '../format';
import { canEdit, useSession } from '../session';

export const TECHNIQUE_LABEL: Record<Technique, string> = {
  five_whys: '5 Whys',
  ishikawa: 'Ishikawa',
  kepner_tregoe: 'Kepner-Tregoe',
  timeline: 'Timeline',
};

const TECHNIQUE_HINT: Record<Technique, string> = {
  five_whys: 'Ask "why?" until you reach a cause that, if removed, prevents recurrence.',
  ishikawa: 'Brainstorm possible causes per category. One cause per line.',
  kepner_tregoe: 'Compare what IS affected with what could be but IS NOT, then test possible causes against both.',
  timeline: 'Line up incidents, changes, deployments and alerts to find what changed before the problem started.',
};

export function AnalysesSection({ problem: p, onChange }: { problem: ProblemDetail; onChange: (p: ProblemDetail) => void }) {
  const { user } = useSession();
  const editable = canEdit(user) && p.status !== 'closed';
  const [selected, setSelected] = useState<number | null>(p.analyses[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const current = p.analyses.find((a) => a.id === selected) ?? p.analyses[0];

  const start = async (technique: Technique) => {
    setError(null);
    try {
      const np = await api.post<ProblemDetail>(`/api/problems/${p.ref}/analyses`, { technique });
      onChange(np);
      setSelected(np.analyses[np.analyses.length - 1].id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="card analyses">
      <div className="section-head">
        <h2>Root cause analysis</h2>
        {editable && (
          <div className="technique-picker">
            {(Object.keys(TECHNIQUE_LABEL) as Technique[]).map((t) => (
              <button key={t} className="chip-btn" onClick={() => start(t)} title={TECHNIQUE_HINT[t]}>+ {TECHNIQUE_LABEL[t]}</button>
            ))}
          </div>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {p.analyses.length === 0 ? (
        <p className="placeholder">No structured analysis yet. Start a 5 Whys, Ishikawa, Kepner-Tregoe or timeline analysis to work towards the root cause.</p>
      ) : (
        <>
          {p.analyses.length > 1 && (
            <div className="tabs" role="tablist">
              {p.analyses.map((a) => (
                <button key={a.id} role="tab" aria-selected={a.id === current?.id} className={a.id === current?.id ? 'on' : ''} onClick={() => setSelected(a.id)}>
                  {a.title}
                </button>
              ))}
            </div>
          )}
          {current && <AnalysisEditor key={current.id} problem={p} analysis={current} editable={editable} onChange={onChange} />}
        </>
      )}
    </section>
  );
}

function AnalysisEditor({ problem: p, analysis, editable, onChange }: { problem: ProblemDetail; analysis: Analysis; editable: boolean; onChange: (p: ProblemDetail) => void }) {
  const [data, setData] = useState<any>(analysis.data);
  const [conclusion, setConclusion] = useState(analysis.conclusion);
  const [title, setTitle] = useState(analysis.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(data) !== JSON.stringify(analysis.data) || conclusion !== analysis.conclusion || title !== analysis.title;

  // Warn before leaving the page with unsaved analysis work.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const [conflict, setConflict] = useState<Conflict | null>(null);
  const save = async (base = analysis.updated_at) => {
    setSaving(true);
    setError(null);
    try {
      onChange(await api.patch<ProblemDetail>(`/api/problems/${p.ref}/analyses/${analysis.id}`, { data, conclusion, title, base_updated_at: base }));
      setConflict(null);
    } catch (err) {
      const c = asConflict(err);
      if (c) setConflict(c);
      else setError((err as Error).message);
      throw err;
    } finally {
      setSaving(false);
    }
  };
  const loadTheirs = async () => {
    const fresh = await api.get<ProblemDetail>(`/api/problems/${p.ref}`);
    const theirs = fresh.analyses.find((a) => a.id === analysis.id);
    if (theirs) {
      setData(theirs.data);
      setConclusion(theirs.conclusion);
      setTitle(theirs.title);
    }
    setConflict(null);
    onChange(fresh);
  };
  const useAsRootCause = async () => {
    const text = p.root_cause.trim() ? `${p.root_cause.trim()}\n\n${conclusion.trim()}` : conclusion.trim();
    try {
      if (dirty) await save();
      onChange(await api.patch<ProblemDetail>(`/api/problems/${p.ref}`, { root_cause: text, base: { root_cause: p.root_cause } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove the analysis "${analysis.title}"?`)) return;
    onChange(await api.del<ProblemDetail>(`/api/problems/${p.ref}/analyses/${analysis.id}`));
  };

  const Editor = { five_whys: FiveWhys, ishikawa: Ishikawa, kepner_tregoe: KepnerTregoe, timeline: Timeline }[analysis.technique];
  return (
    <div className="analysis">
      <div className="analysis-head">
        {editable ? <input className="analysis-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Analysis title" /> : <h3>{title}</h3>}
        <span className="tag">{TECHNIQUE_LABEL[analysis.technique]}</span>
        <span className="muted small">Updated by {analysis.updated_by} {relativeTime(analysis.updated_at)}</span>
      </div>
      <p className="muted small">{TECHNIQUE_HINT[analysis.technique]}</p>
      <Editor data={data} set={setData} readOnly={!editable} />
      <label className="conclusion">
        Conclusion
        <textarea rows={3} value={conclusion} readOnly={!editable} onChange={(e) => setConclusion(e.target.value)} placeholder="What does this analysis tell us about the root cause?" />
      </label>
      {error && <div className="error">{error}</div>}
      {conflict && (
        <div className="conflict">
          <strong>{conflict.changed_by ?? 'Someone'} saved this analysis while you were editing.</strong>
          <div className="actions">
            <button className="btn" onClick={loadTheirs}>Discard mine, load theirs</button>
            <button className="btn danger" onClick={() => save(conflict.current?.updated_at).catch(() => {})}>Overwrite with mine</button>
          </div>
        </div>
      )}
      {editable && (
        <div className="actions">
          <button className="btn-link danger spacer-right" onClick={remove}>Remove</button>
          <button className="btn" disabled={!conclusion.trim()} onClick={useAsRootCause} title="Append the conclusion to the problem's root cause">
            Use as root cause
          </button>
          <button className="btn primary" disabled={!dirty || saving || !!conflict} onClick={() => save().catch(() => {})}>{saving ? 'Saving…' : dirty ? 'Save analysis' : 'Saved'}</button>
        </div>
      )}
    </div>
  );
}

interface EditorProps {
  data: any;
  set: (d: any) => void;
  readOnly: boolean;
}

/** Immutable update helpers for nested arrays. */
const replaceAt = <T,>(list: T[], i: number, value: T) => list.map((x, j) => (j === i ? value : x));
const removeAt = <T,>(list: T[], i: number) => list.filter((_, j) => j !== i);

function FiveWhys({ data, set, readOnly }: EditorProps) {
  const whys: { why: string; because: string }[] = data.whys ?? [];
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
            </div>
            {!readOnly && <button className="btn-icon small" aria-label="Remove step" onClick={() => set({ ...data, whys: removeAt(whys, i) })}>×</button>}
          </li>
        ))}
      </ol>
      {!readOnly && <button className="btn-link small" onClick={() => set({ ...data, whys: [...whys, { why: '', because: '' }] })}>+ Ask why</button>}
    </div>
  );
}

function Ishikawa({ data, set, readOnly }: EditorProps) {
  const categories: { name: string; causes: string[] }[] = data.categories ?? [];
  return (
    <div className="ishikawa">
      <label>Effect (the problem)
        <input value={data.effect ?? ''} readOnly={readOnly} onChange={(e) => set({ ...data, effect: e.target.value })} placeholder="E.g. Orders time out at peak" />
      </label>
      <Fishbone effect={data.effect ?? ''} categories={categories} />
      <div className="ishikawa-grid">
        {categories.map((c, i) => (
          <label key={i}>
            {readOnly ? c.name : (
              <input className="category-name" value={c.name} onChange={(e) => set({ ...data, categories: replaceAt(categories, i, { ...c, name: e.target.value }) })} />
            )}
            <textarea
              rows={Math.max(3, c.causes.length + 1)}
              readOnly={readOnly}
              value={c.causes.join('\n')}
              placeholder="One cause per line"
              onChange={(e) => set({ ...data, categories: replaceAt(categories, i, { ...c, causes: e.target.value.split('\n') }) })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

/** A compact fishbone diagram: categories alternate above and below the spine. */
function Fishbone({ effect, categories }: { effect: string; categories: { name: string; causes: string[] }[] }) {
  const cats = categories.filter((c) => c.name.trim());
  const perSide = Math.max(1, Math.ceil(cats.length / 2));
  const W = 900, H = 340, spineY = H / 2, headX = 700, startX = 150;
  const step = (headX - startX) / (perSide + 0.5);
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  return (
    <svg className="fishbone" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Fishbone diagram">
      <line x1={startX} y1={spineY} x2={headX} y2={spineY} className="fb-spine" />
      <polygon points={`${headX},${spineY - 9} ${headX + 14},${spineY} ${headX},${spineY + 9}`} className="fb-arrow" />
      <foreignObject x={headX + 20} y={spineY - 45} width={W - headX - 22} height={90}>
        <div className="fb-effect">{effect || 'Effect'}</div>
      </foreignObject>
      {cats.map((c, i) => {
        const top = i % 2 === 0;
        const slot = Math.floor(i / 2);
        const x = startX + step * (slot + 1);
        const endY = top ? 34 : H - 34;
        const endX = x - 60;
        const causes = c.causes.filter((s) => s.trim()).slice(0, 5);
        return (
          <g key={i}>
            <line x1={endX} y1={endY} x2={x} y2={spineY} className="fb-bone" />
            <text x={endX} y={top ? endY - 10 : endY + 20} className="fb-cat" textAnchor="middle">{clip(c.name, 18)}</text>
            {causes.map((cause, j) => {
              const t = (j + 1) / (causes.length + 1);
              const bx = endX + (x - endX) * t;
              const by = endY + (spineY - endY) * t;
              return (
                <g key={j}>
                  <line x1={bx - 70} y1={by} x2={bx} y2={by} className="fb-cause-line" />
                  <text x={bx - 72} y={by + 4} className="fb-cause" textAnchor="end">{clip(cause, 22)}</text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

const KT_DIMENSIONS = [
  ['what', 'What', 'Which object or system, what defect?'],
  ['where', 'Where', 'Where is it observed: location, component, environment?'],
  ['when', 'When', 'When did it start, when does it occur, in what pattern?'],
  ['extent', 'Extent', 'How many, how big, is it growing?'],
] as const;

function KepnerTregoe({ data, set, readOnly }: EditorProps) {
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

const EVENT_KINDS = ['incident', 'change', 'deployment', 'alert', 'observation', 'other'];

function Timeline({ data, set, readOnly: locked }: EditorProps) {
  const events: { at: string; kind: string; description: string; reference: string }[] = data.events ?? [];
  const [editing, setEditing] = useState(events.length === 0);
  const readOnly = locked || !editing;
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.at.localeCompare(b.e.at));
  const add = () => set({ ...data, events: [...events, { at: new Date().toISOString().slice(0, 16), kind: 'observation', description: '', reference: '' }] });
  return (
    <div className="timeline">
      {sorted.length === 0 && <p className="placeholder">No events yet.</p>}
      <ol className="tl">
        {sorted.map(({ e, i }) => (
          <li key={i} className={`tl-${e.kind}`}>
            <span className="tl-dot" />
            {readOnly ? (
              <div className="tl-view">
                <div className="tl-meta"><time>{e.at.replace('T', ' ')}</time><span className="tag">{e.kind}</span>{e.reference && <span className="mono small">{e.reference}</span>}</div>
                <div>{e.description}</div>
              </div>
            ) : (
              <div className="tl-edit">
                <input type="datetime-local" value={e.at} onChange={(ev) => set({ ...data, events: replaceAt(events, i, { ...e, at: ev.target.value }) })} />
                <select value={e.kind} onChange={(ev) => set({ ...data, events: replaceAt(events, i, { ...e, kind: ev.target.value }) })}>
                  {EVENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <input placeholder="Reference" value={e.reference} onChange={(ev) => set({ ...data, events: replaceAt(events, i, { ...e, reference: ev.target.value }) })} />
                <input className="tl-desc" placeholder="What happened" value={e.description} onChange={(ev) => set({ ...data, events: replaceAt(events, i, { ...e, description: ev.target.value }) })} />
                <button className="btn-icon small" aria-label="Remove event" onClick={() => set({ ...data, events: removeAt(events, i) })}>×</button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {!locked && (
        <div className="row-actions">
          {editing && <button className="btn-link small" onClick={add}>+ Event</button>}
          {events.length > 0 && <button className="btn-link small" onClick={() => setEditing(!editing)}>{editing ? 'Done editing' : 'Edit events'}</button>}
        </div>
      )}
    </div>
  );
}
