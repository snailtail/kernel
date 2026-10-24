import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from '../../api/client';
import { TwoFactor } from '../../components/TwoFactor';
import { passkeysSupported, signInWithPasskey } from '../../components/Passkeys';

export function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // After SSO or Cloudflare Access, accounts with two-factor authentication still enter their code. After SSO the
  // challenge waits in an httpOnly cookie; the empty string means "use that cookie".
  const [challenge, setChallenge] = useState<string | null>(null);
  const [methods, setMethods] = useState<string[]>(['totp']);
  const passkey = async (mfaToken?: string) => {
    setError(null);
    try {
      onLogin(await signInWithPasskey<User>(mfaToken));
    } catch (err) {
      setError((err as Error).name === 'NotAllowedError' ? 'Cancelled.' : (err as Error).message);
    }
  };
  const [code, setCode] = useState('');
  const [options, setOptions] = useState<{ sso: { label: string } | null; cf_access: boolean; local_login: 'all' | 'admins' } | null>(null);
  useEffect(() => {
    api.get<{ pending: boolean }>('/api/auth/mfa-pending').then((p) => p.pending && setChallenge(''), () => {});
    api.get<NonNullable<typeof options>>('/api/auth/options').then(async (o) => {
      setOptions(o);
      // Behind Cloudflare Access, people have signed in already: start a Kernel session from its token.
      if (o.cf_access) {
        try {
          const r = await api.post<{ ok?: boolean; mfa_required?: boolean; mfa_token?: string }>('/api/auth/access', {});
          if (r.mfa_required) setChallenge(r.mfa_token!);
          else onLogin(await api.get<User>('/api/auth/me'));
        } catch {
          // no Access token (or no account): the other options remain
        }
      }
    }, () => setOptions({ sso: null, cf_access: false, local_login: 'all' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge !== null) {
        onLogin(await api.post<User>('/api/auth/login/mfa', { ...(challenge ? { mfa_token: challenge } : {}), code }));
      } else {
        const res = await api.post<User & { mfa_required?: boolean; mfa_token?: string; methods?: string[] }>('/api/auth/login', { username, password });
        if (res.mfa_required) {
          setChallenge(res.mfa_token!);
          setMethods(res.methods ?? ['totp']);
          if (res.methods?.length === 1 && res.methods[0] === 'passkey') await passkey(res.mfa_token);
        }
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
        {options?.sso && !challenge && (
          <>
            <a className="btn primary sso-btn" href={`/api/auth/sso/start?return=${encodeURIComponent(window.location.pathname + window.location.search)}`}>{options.sso.label}</a>
            <div className="login-divider muted small">{options.local_login === 'admins' ? 'Administrators only (break-glass)' : 'or with a Kernel account'}</div>
          </>
        )}
        {challenge === null && passkeysSupported() && <button type="button" className="btn passkey-btn" onClick={() => passkey()}>Sign in with a passkey</button>}
        {challenge !== null ? (
          <>
            {methods.includes('passkey') && <button type="button" className="btn primary" onClick={() => passkey(challenge || undefined)}>Use a passkey</button>}
            {methods.includes('totp') && <p className="muted small">Enter the code from your authenticator app, or one of your recovery codes.</p>}
            {methods.includes('totp') && (
              <label>
                Code
                <input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
              </label>
            )}
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
        {!(challenge !== null && !methods.includes('totp')) && <button className="btn primary" disabled={busy || (challenge !== null ? !code.trim() : !username || !password)}>
          {busy ? 'Signing in…' : challenge !== null ? 'Verify' : 'Sign in'}
        </button>}
        {challenge !== null && <button type="button" className="btn-link" onClick={() => { setChallenge(null); setCode(''); }}>Start over</button>}
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
