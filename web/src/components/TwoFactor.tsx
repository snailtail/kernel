import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { formatDate } from '../format';
import { useApi } from '../hooks';

interface Status { enabled: boolean; enabled_at: string | null; recovery_codes_left: number; required: boolean }

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `Kernel recovery codes (each works once)\n\n${codes.join('\n')}\n`;
  return (
    <div className="recovery">
      <strong>Save these recovery codes now – they are shown only once.</strong>
      <p className="muted small">Each code signs you in once if you lose access to your authenticator app.</p>
      <ul className="recovery-codes">{codes.map((c) => <li key={c} className="mono">{c}</li>)}</ul>
      <div className="actions">
        <button className="btn" onClick={() => navigator.clipboard?.writeText(text)}>Copy</button>
        <a className="btn" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download="kernel-recovery-codes.txt">Download</a>
        <button className="btn primary" onClick={onDone}>I have saved them</button>
      </div>
    </div>
  );
}

/** Two-factor authentication: status, TOTP enrolment, recovery codes and turning it off. */
export function TwoFactor({ onEnabled }: { onEnabled?: () => void }) {
  const { data: status, reload } = useApi<Status>('/api/auth/mfa');
  const [setup, setSetup] = useState<{ secret: string; qr: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const start = () => run(async () => setSetup(await api.post('/api/auth/mfa/setup')));
  const enable = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const res = await api.post<{ recovery_codes: string[] }>('/api/auth/mfa/enable', { code });
      setSetup(null);
      setCode('');
      setCodes(res.recovery_codes);
      reload();
    });
  };
  const disable = () => {
    if (confirm('Turn off two-factor authentication? Your account will be protected by the password alone.')) run(async () => { await api.post('/api/auth/mfa/disable'); reload(); });
  };
  const regenerate = () => {
    if (confirm('Replace your recovery codes? The old ones stop working.')) run(async () => setCodes((await api.post<{ recovery_codes: string[] }>('/api/auth/mfa/recovery-codes')).recovery_codes));
  };

  if (!status) return null;
  if (codes) return <RecoveryCodes codes={codes} onDone={() => { setCodes(null); onEnabled?.(); }} />;
  return (
    <div className="two-factor">
      {status.enabled ? (
        <>
          <p><span className="badge status-resolved">On</span> since {formatDate(status.enabled_at)} · {status.recovery_codes_left} recovery codes left</p>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn" onClick={regenerate}>New recovery codes</button>
            {!status.required && <button className="btn danger" onClick={disable}>Turn off</button>}
          </div>
          {status.required && <p className="muted small">Your role requires two-factor authentication.</p>}
        </>
      ) : setup ? (
        <form className="mfa-setup" onSubmit={enable}>
          <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} />
          <div>
            <ol>
              <li>Scan the QR code with an authenticator app (Microsoft or Google Authenticator, 1Password, Bitwarden…).</li>
              <li>Or enter this key manually: <code className="secret-key">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code></li>
              <li>Enter the six-digit code the app shows.</li>
            </ol>
            <div className="inline-form">
              <input inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
              <button className="btn primary" disabled={code.replace(/\s/g, '').length !== 6}>Turn on</button>
            </div>
          </div>
        </form>
      ) : (
        <>
          <p className="muted">Protect your account with a code from an authenticator app in addition to your password.</p>
          <button className="btn primary" onClick={start}>Set up two-factor authentication</button>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
