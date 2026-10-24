import { useState } from 'react';
import { api, type ProblemDetail, type Technique } from '../../../api/client';
import { canEdit, useSession } from '../../../session';
import { TECHNIQUE_LABEL, TECHNIQUE_HINT } from './analyses/common';
import { AnalysisEditor } from './analyses/AnalysisEditor';

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
