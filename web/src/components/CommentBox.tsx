import { useState, type ReactNode } from 'react';
import { richPaste } from './RichPaste';

/** Whether a note goes to the record's caller or requester (they see it in the portal and by email) or stays internal. */
interface Audience {
  name: string;
  reply: boolean;
  onReply: (reply: boolean) => void;
}

/**
 * The "add a note" box on a record page. `onSubmit` posts the note; the box empties unless it returns false (the page
 * shows the error). Pasted screenshots and logs become attachments on `recordRef` unless `paste` is off.
 */
export function CommentBox({ recordRef, placeholder, submitLabel = 'Add note', rows = 2, paste = true, audience, extra, error, compact, onSubmit, onError }: {
  recordRef: string;
  placeholder: string;
  submitLabel?: string;
  rows?: number;
  paste?: boolean;
  audience?: Audience;
  /** Controls next to the submit button (e.g. the kind of note). */
  extra?: ReactNode;
  /** An error shown inside the box, for pages that keep it there rather than in the header. */
  error?: string | null;
  /** A plain textarea and a small button, for side panels. */
  compact?: boolean;
  onSubmit: (body: string) => Promise<boolean | void>;
  onError?: (message: string | null) => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      if ((await onSubmit(body)) !== false) setBody('');
    } finally {
      setBusy(false);
    }
  };
  const textarea = (
    <textarea rows={rows} placeholder={placeholder} aria-label={compact ? 'Note' : undefined} value={body} onChange={(e) => setBody(e.target.value)}
      {...(paste ? richPaste(recordRef, setBody, onError) : {})} />
  );
  if (compact) {
    return (
      <form className="no-print" onSubmit={(e) => { e.preventDefault(); if (body.trim()) void submit(); }}>
        {textarea}
        <button className="btn small" disabled={busy || !body.trim()}>{submitLabel}</button>
      </form>
    );
  }
  return (
    <form className="comment-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {audience && (
        <div className="note-audience" role="radiogroup" aria-label="Who reads this">
          <label className="check"><input type="radio" name="note-audience" checked={!audience.reply} onChange={() => audience.onReply(false)} /> Internal note</label>
          <label className="check"><input type="radio" name="note-audience" checked={audience.reply} onChange={() => audience.onReply(true)} /> Reply to {audience.name}</label>
        </div>
      )}
      {textarea}
      {error && <div className="error">{error}</div>}
      <div className="actions">
        {extra}
        <button className="btn primary" disabled={busy || !body.trim()}>{submitLabel}</button>
      </div>
    </form>
  );
}
