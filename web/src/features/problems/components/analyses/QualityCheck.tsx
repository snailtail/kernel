import { useEffect, useState } from 'react';
import { api } from '../../../../api/client';

/** Server-side quality check of the saved analysis (same check agents run with check_analysis). */
export function QualityCheck({ problemRef, analysisId, version, dirty }: { problemRef: string; analysisId: number; version: string; dirty: boolean }) {
  const [check, setCheck] = useState<{ ready: boolean; findings: { level: 'error' | 'warning'; message: string }[] } | null>(null);
  useEffect(() => {
    api.get<typeof check>(`/api/problems/${problemRef}/analyses/${analysisId}/check`).then(setCheck).catch(() => {});
  }, [problemRef, analysisId, version]);
  if (!check) return null;
  return (
    <div className={`quality ${check.ready ? 'ready' : ''}`}>
      <strong>{check.ready ? '✓ Ready to conclude' : 'Before concluding'}</strong>{dirty && <span className="muted small"> (checks the saved version)</span>}
      {check.findings.length > 0 && (
        <ul>{check.findings.map((f) => <li key={f.message} className={`finding-${f.level}`}>{f.message}</li>)}</ul>
      )}
    </div>
  );
}
