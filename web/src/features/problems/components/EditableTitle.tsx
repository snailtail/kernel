import { useState } from 'react';
import '../styles.css';

export function EditableTitle({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <h1 className={editable ? 'editable' : ''} onClick={() => editable && setDraft(value)} title={editable ? 'Click to edit' : undefined}>
        {value}
      </h1>
    );
  }
  const commit = async () => {
    if (draft.trim() && draft !== value) await onSave(draft.trim()).catch(() => {});
    setDraft(null);
  };
  return (
    <input className="title-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }} />
  );
}
