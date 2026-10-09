import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from './Modal';

interface Request {
  title: string;
  message: string;
  label: string;
  confirmLabel: string;
  danger?: boolean;
  audited?: boolean;
  multiline?: boolean;
  resolve: (value: string | null) => void;
}

let open: ((r: Request) => void) | null = null;

/**
 * Asks for a reason (recorded in the audit trail) and resolves with it, or null when cancelled.
 * Rendered once by <AskHost />.
 */
export function askReason(title: string, message: string, options: { confirmLabel?: string; danger?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (!open) return resolve(window.prompt(message)?.trim() || null);
    open({ title, message, label: 'Reason', confirmLabel: options.confirmLabel ?? 'Continue', danger: options.danger, audited: true, multiline: true, resolve });
  });
}

/** Asks for a short text (e.g. a name); resolves with it, or null when cancelled. */
export function askText(title: string, label: string, options: { confirmLabel?: string; message?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (!open) return resolve(window.prompt(label)?.trim() || null);
    open({ title, message: options.message ?? '', label, confirmLabel: options.confirmLabel ?? 'Save', resolve });
  });
}

export function AskHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    open = (r) => {
      setValue('');
      setReq(r);
    };
    return () => {
      open = null;
    };
  }, []);
  if (!req) return null;
  const close = (v: string | null) => {
    req.resolve(v);
    setReq(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) close(value.trim());
  };
  return (
    <Modal title={req.title} onClose={() => close(null)}>
      <form className="form" onSubmit={submit}>
        {req.message && <p className="hint full">{req.message}</p>}
        <label className="full">
          {req.label} {req.audited && <span className="muted small">(recorded in the audit trail)</span>}
          {req.multiline ? (
            <textarea autoFocus rows={3} value={value} onChange={(e) => setValue(e.target.value)} maxLength={1000} />
          ) : (
            <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} />
          )}
        </label>
        <div className="actions full">
          <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
          <button className={`btn ${req.danger ? 'danger' : 'primary'}`} disabled={!value.trim()}>{req.confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
