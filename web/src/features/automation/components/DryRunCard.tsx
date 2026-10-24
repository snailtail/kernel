import { useState } from 'react';
import { api } from '../../../api/client';
import type { RuleDraft, RuleDryRun } from '../../../api/types/rules';
import '../styles.css';

export function DryRunCard({ rule }: { rule: RuleDraft & { id?: number } }) {
  const [result, setResult] = useState<RuleDryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    try {
      setResult(await api.post<RuleDryRun>('/api/rules/dry-run', rule.id ? { id: rule.id } : { name: rule.name || 'Draft', kind: rule.kind, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    }
  };
  return (
    <section className="card dry-run">
      <h2>Dry run</h2>
      <p className="muted small">Checks the conditions against the records updated in the last 30 days. Nothing changes.</p>
      <button type="button" className="btn" onClick={run}>Try it</button>
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="dry-run-result" role="status">
          <p><strong>It would have matched {result.matched}</strong> of {result.checked}.</p>
          {result.latest.length > 0 && <ul className="plain-list small">{result.latest.map((x) => <li key={x.ref}><span className="mono">{x.ref}</span> {x.title}</li>)}</ul>}
          <p className="muted small">{result.note}</p>
        </div>
      )}
    </section>
  );
}
