import { useEffect, useState } from 'react';
import { api, type Technique } from '../../../../api/client';
import { TECHNIQUE_LABEL, TECHNIQUE_HINT } from './common';

interface Guide { id: string; title: string; purpose: string; when: string; steps: string[]; stop: string; pitfalls: string[]; example?: { good: string; bad: string } }

/** The method guide for a technique: the same text agents get as an MCP resource. */
export function MethodGuide({ technique }: { technique: Technique }) {
  const [open, setOpen] = useState(false);
  const [guide, setGuide] = useState<Guide | null>(null);
  useEffect(() => {
    if (open && !guide) api.get<Guide>(`/api/guides/${technique}`).then(setGuide).catch(() => {});
  }, [open, guide, technique]);
  return (
    <div className="method-guide">
      <button className="btn-link small" onClick={() => setOpen(!open)}>{open ? 'Hide method guide' : `How to do a ${TECHNIQUE_LABEL[technique]} analysis`}</button>
      {!open && <span className="muted small"> · {TECHNIQUE_HINT[technique]}</span>}
      {open && guide && (
        <div className="guide-body">
          <p>{guide.purpose} <span className="muted">{guide.when}</span></p>
          <ol>{guide.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          <p><strong>Done when:</strong> {guide.stop}</p>
          <p className="muted small"><strong>Pitfalls:</strong> {guide.pitfalls.join(' ')}</p>
          {guide.example && <p className="muted small">Good: {guide.example.good}<br />Bad: {guide.example.bad}</p>}
        </div>
      )}
    </div>
  );
}
