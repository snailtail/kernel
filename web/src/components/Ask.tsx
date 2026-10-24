import { useEffect, useState } from 'react';
import { FormModal } from './Modal';

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
  return (
    <FormModal title={req.title} submitLabel={req.confirmLabel} danger={req.danger} canSubmit={!!value.trim()} onClose={() => close(null)} onSubmit={async () => close(value.trim())}>
      {req.message && <p className="hint full">{req.message}</p>}
      <label className="full">
        {req.label} {req.audited && <span className="muted small">(kept permanently in the audit trail – no personal details; refer to people by account or record ref)</span>}
        {req.multiline ? (
          <textarea autoFocus rows={3} value={value} onChange={(e) => setValue(e.target.value)} maxLength={1000} />
        ) : (
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} />
        )}
      </label>
    </FormModal>
  );
}
