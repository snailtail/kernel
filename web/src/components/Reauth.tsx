import { useEffect, useState, type FormEvent } from 'react';
import { api, setReauthHandler } from '../api';
import { Modal } from './Modal';

/** Asks for the password (and code) when the server requires a recent re-authentication, then lets the request retry. */
export function ReauthPrompt() {
  const [pending, setPending] = useState<{ mfa: boolean; resolve: (ok: boolean) => void } | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReauthHandler((mfa) => new Promise((resolve) => setPending({ mfa, resolve })));
    return () => setReauthHandler(null);
  }, []);

  if (!pending) return null;
  const close = (ok: boolean) => {
    pending.resolve(ok);
    setPending(null);
    setPassword('');
    setCode('');
    setError(null);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/auth/reauth', { password, code: pending.mfa ? code : undefined });
      close(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Confirm it is you" onClose={() => close(false)}>
      <form className="form" onSubmit={submit}>
        <p className="hint full">This action changes access or security settings. Confirm your identity to continue.</p>
        <label className="full">Password<input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {pending.mfa && (
          <label className="full">Code from your authenticator app
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
          </label>
        )}
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
          <button className="btn primary" disabled={!password}>Confirm</button>
        </div>
      </form>
    </Modal>
  );
}
