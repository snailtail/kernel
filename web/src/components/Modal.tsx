import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A modal holding one form: the fields, then Cancel and the submit button. `onSubmit` does the work; a thrown error
 * is shown above the buttons and the modal stays open. `actions` go left of Cancel (e.g. Delete); `canSubmit` false
 * keeps the submit button off until the form is filled in. `intro` sits above the form (e.g. a guide).
 */
export function FormModal({ title, submitLabel, danger, submitClass, canSubmit = true, actions, cancelLabel = 'Cancel', intro, onClose, onSubmit, children }: {
  title: string;
  submitLabel: string;
  danger?: boolean;
  /** The submit button's classes when neither primary nor danger fits (e.g. 'btn primary danger'). */
  submitClass?: string;
  canSubmit?: boolean;
  actions?: ReactNode;
  cancelLabel?: string;
  intro?: ReactNode;
  onClose: () => void;
  onSubmit: () => Promise<unknown>;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      {intro}
      <form className="form" onSubmit={submit}>
        {children}
        {error && <div className="error full" role="alert">{error}</div>}
        <div className="actions full">
          {actions}
          <button type="button" className="btn" onClick={onClose}>{cancelLabel}</button>
          <button className={submitClass ?? `btn ${danger ? 'danger' : 'primary'}`} disabled={busy || !canSubmit}>{submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
