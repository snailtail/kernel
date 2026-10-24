import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../../api/client';
import { useApi } from '../../hooks';
import { canEdit, isManager, useSession } from '../../session';
import type { CandidateRuleId, Candidate, CandidateList } from '../../api/types/candidates';
import { CandidateCard } from './components/CandidateCard';
import { RulesCard } from './components/RulesCard';
import { DecisionModal } from './components/DecisionModal';
import { CreateModal } from './components/CreateModal';
import { LinkModal } from './components/LinkModal';

export function CandidatesPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const rule = (params.get('rule') ?? '') as CandidateRuleId | '';
  const show = params.get('show') === 'hidden' ? 'hidden' : 'open';
  const { data, reload } = useApi<CandidateList>(`/api/candidates?${new URLSearchParams({ ...(rule ? { rule } : {}), show })}`);
  const [creating, setCreating] = useState<Candidate | null>(null);
  const [linking, setLinking] = useState<Candidate | null>(null);
  const [deciding, setDeciding] = useState<Candidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editable = canEdit(user);
  const set = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? p.set(k, v) : p.delete(k);
    setParams(p, { replace: true });
  };
  const restore = async (c: Candidate) => {
    try {
      await api.post('/api/candidates/restore', { key: c.key });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const active = data?.rules.filter((r) => r.enabled) ?? [];
  const total = active.reduce((n, r) => n + r.count, 0);
  const hiddenCount = (data?.hidden.dismissed ?? 0) + (data?.hidden.snoozed ?? 0);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Problem candidates</h1>
          <p className="muted">
            Records worth a problem, found by rules over incidents, events and the CMDB, or reported by external analysis. Each says why, with the evidence.
          </p>
        </div>
      </header>
      {data && (
        <div className="candidate-toolbar">
          <div className="tabs" role="group" aria-label="Rule">
            <button className={!rule ? 'on' : ''} onClick={() => set({ rule: '' })}>All <span className="muted">{total}</span></button>
            {active.map((r) => (
              <button key={r.rule} className={rule === r.rule ? 'on' : ''} onClick={() => set({ rule: r.rule })}>{r.label} <span className="muted">{r.count}</span></button>
            ))}
          </div>
          <button className="btn-link" onClick={() => set({ show: show === 'hidden' ? '' : 'hidden' })}>
            {show === 'hidden' ? 'Back to open candidates' : `Dismissed and snoozed (${hiddenCount})`}
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {data?.rules.some((r) => r.error) && (
        <div className="hint-box candidate-rule-errors" role="status">
          This rule could not run, so its candidates are missing for now: {data.rules.filter((r) => r.error).map((r) => `${r.label} (${r.error!.toLowerCase()})`).join(', ')}. The other rules are listed as usual.
        </div>
      )}
      {data?.candidates.length === 0 && (
        <section className="card">
          <p className="empty">
            {show === 'hidden'
              ? 'Nothing is dismissed or snoozed.'
              : 'No candidates right now. They appear when a rule below finds something, or when a tool reports one (see the API section under Settings).'}
          </p>
        </section>
      )}
      {data && [false, true].map((proactive) => {
        const list = data.candidates.filter((c) => c.proactive === proactive);
        if (!list.length) return null;
        return (
          <section key={String(proactive)} className="candidate-section">
            {proactive && (
              <header className="section-head">
                <h2>Before it hurts</h2>
                <p className="muted small">Trends in monitoring and changes, and findings from external analysis: problems waiting to happen.</p>
              </header>
            )}
            <div className="candidates">
              {list.map((c) => (
                <CandidateCard key={c.key} c={c} editable={editable}
                  onCreate={() => setCreating(c)} onLink={() => setLinking(c)} onDecide={() => setDeciding(c)} onRestore={() => restore(c)} />
              ))}
            </div>
          </section>
        );
      })}
      {data && <RulesCard rules={data.rules} editable={isManager(user)} onSaved={reload} />}
      {creating && <CreateModal candidate={creating} onClose={() => setCreating(null)} />}
      {linking && <LinkModal candidate={linking} onClose={() => setLinking(null)} />}
      {deciding && <DecisionModal candidate={deciding} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); reload(); }} />}
    </>
  );
}
