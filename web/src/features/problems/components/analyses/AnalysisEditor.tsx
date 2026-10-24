import { useEffect, useState } from 'react';
import { api, asConflict, type Analysis, type Conflict, type ProblemDetail } from '../../../../api/client';
import { relativeTime } from '../../../../format';
import { TECHNIQUE_LABEL } from './common';
import { FiveWhys } from './FiveWhys';
import { Ishikawa } from './Ishikawa';
import { KepnerTregoe } from './KepnerTregoe';
import { Timeline } from './Timeline';
import { MethodGuide } from './MethodGuide';
import { QualityCheck } from './QualityCheck';

export function AnalysisEditor({ problem: p, analysis, editable, onChange }: { problem: ProblemDetail; analysis: Analysis; editable: boolean; onChange: (p: ProblemDetail) => void }) {
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
  const confirm = async () => {
    try {
      onChange(await api.post<ProblemDetail>(`/api/problems/${p.ref}/analyses/${analysis.id}/confirm`));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove the analysis "${analysis.title}"?`)) return;
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
      {analysis.proposed_via_mcp && (
        <div className="proposed">
          <span><strong>Proposed via MCP.</strong> An AI agent wrote or changed this analysis; review it before relying on it.</span>
          {editable && <button className="btn small" onClick={confirm}>Confirm analysis</button>}
        </div>
      )}
      <MethodGuide technique={analysis.technique} />
      <Editor data={data} set={setData} readOnly={!editable} />
      <label className="conclusion">
        Conclusion
        <textarea rows={3} value={conclusion} readOnly={!editable} onChange={(e) => setConclusion(e.target.value)} placeholder="What does this analysis tell us about the root cause?" />
      </label>
      <QualityCheck problemRef={p.ref} analysisId={analysis.id} version={analysis.updated_at} dirty={dirty} />
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
