import { useState, type FormEvent } from 'react';
import { api, type User } from '../api';
import { TwoFactor } from '../components/TwoFactor';

export function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        onLogin(await api.post<User>('/api/auth/login/mfa', { mfa_token: challenge, code }));
      } else {
        const res = await api.post<User & { mfa_required?: boolean; mfa_token?: string }>('/api/auth/login', { username, password });
        if (res.mfa_required) setChallenge(res.mfa_token!);
        else onLogin(res);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <div>
            <div className="brand-name">Kernel</div>
            <div className="brand-sub">Problem Management</div>
          </div>
        </div>
        {challenge ? (
          <>
            <p className="muted small">Enter the code from your authenticator app, or one of your recovery codes.</p>
            <label>
              Code
              <input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            </label>
          </>
        ) : (
          <>
            <label>
              Username
              <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label>
              Password
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy || (challenge ? !code.trim() : !username || !password)}>
          {busy ? 'Signing in…' : challenge ? 'Verify' : 'Sign in'}
        </button>
        {challenge && <button type="button" className="btn-link" onClick={() => { setChallenge(null); setCode(''); }}>Start over</button>}
      </form>
    </div>
  );
}

/** Shown instead of the app until a generated initial password has been replaced. */
export function ChangeInitialPassword({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The new passwords do not match');
    try {
      await api.post('/api/auth/password', { current, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <div>
            <div className="brand-name">Choose your password</div>
            <div className="brand-sub">Replace the generated password</div>
          </div>
        </div>
        <p className="muted small">This account still uses a generated password. Choose your own before continuing; a long passphrase is best.</p>
        <label>Current (generated) password<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label>New password<input type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={!current || !password}>Save and continue</button>
        <button type="button" className="btn-link" onClick={onLogout}>Sign out</button>
      </form>
    </div>
  );
}

/** Shown when the user's role requires two-factor authentication and it is not set up yet. */
export function EnrollTwoFactor({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  return (
    <div className="login">
      <div className="login-card wide">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <div>
            <div className="brand-name">Set up two-factor authentication</div>
            <div className="brand-sub">Required for your role</div>
          </div>
        </div>
        <TwoFactor onEnabled={onDone} />
        <button type="button" className="btn-link" onClick={onLogout}>Sign out</button>
      </div>
    </div>
  );
}
