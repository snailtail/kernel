import { useState } from 'react';
import { asConflict, type Conflict } from '../../../api/client';
import { Markdown } from '../../../components/Markdown';
import { richPaste } from '../../../components/RichPaste';
import { relativeTime } from '../../../format';
import '../styles.css';

export function TextSection(props: { recordRef: string; title: string; hint: string; value: string; editable: boolean; onSave: (v: string, base: string) => Promise<void>; proposed?: boolean; onConfirm?: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const start = () => {
    setBase(props.value);
    setDraft(props.value);
    setConflict(null);
  };
  const commit = async (against = base) => {
    setBusy(true);
    try {
      await props.onSave(draft ?? '', against);
      setDraft(null);
      setConflict(null);
    } catch (err) {
      setConflict(asConflict(err));
    } finally {
      setBusy(false);
    }
  };
  const theirs = conflict?.conflicts?.[0]?.current as string | undefined;
  return (
    <section className="card text-section">
      <div className="section-head">
        <h2>{props.title} {props.proposed && <span className="badge proposed-badge" title="Written by an AI agent through MCP; not yet confirmed by a person">Proposed via MCP</span>}</h2>
        <span className="section-actions">
          {props.proposed && props.editable && props.onConfirm && draft === null && <button className="btn-link" onClick={props.onConfirm}>Confirm</button>}
          {props.editable && draft === null && <button className="btn-link" onClick={start}>Edit</button>}
        </span>
      </div>
      {draft !== null ? (
        <>
          {conflict && (
            <div className="conflict">
              <strong>{conflict.changed_by ?? 'Someone'} changed this{conflict.changed_at ? ` ${relativeTime(conflict.changed_at)}` : ''} while you were editing.</strong>
              <div className="conflict-theirs">
                <span className="muted small">Their version</span>
                {theirs ? <Markdown text={theirs} /> : <p className="muted">(empty)</p>}
              </div>
              <div className="actions">
                <button className="btn" onClick={() => { setDraft(null); setConflict(null); }}>Discard mine, keep theirs</button>
                <button className="btn" onClick={() => setDraft(`${theirs ?? ''}\n\n${draft}`)}>Combine both</button>
                <button className="btn danger" onClick={() => { setBase(theirs ?? ''); commit(theirs ?? ''); }}>Overwrite with mine</button>
              </div>
            </div>
          )}
          <textarea autoFocus rows={Math.max(5, draft.split('\n').length + 1)} value={draft} placeholder={props.hint} onChange={(e) => setDraft(e.target.value)} {...richPaste(props.recordRef, setDraft, setPasteError)} />
          {pasteError && <div className="error small">{pasteError}</div>}
          <span className="muted small">Markdown supported. Paste a screenshot or formatted text; Ctrl+Shift+V pastes plain text.</span>
          <div className="actions">
            <button className="btn" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
            <button className="btn primary" onClick={() => commit()} disabled={busy || !!conflict}>Save</button>
          </div>
        </>
      ) : props.value ? (
        <Markdown text={props.value} />
      ) : (
        <p className="placeholder">{props.hint}</p>
      )}
    </section>
  );
}
