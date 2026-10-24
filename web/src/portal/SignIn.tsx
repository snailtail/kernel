import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { TEXT } from './text';
import { errorText, Notice } from './common';

export function SignIn() {
  const [params] = useSearchParams();
  const [options, setOptions] = useState<{ sso: boolean; email: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(params.get('signin') === 'unknown' ? { kind: 'error', text: TEXT.signInUnknown } : null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ sso: boolean; email: boolean }>('/api/portal/auth/options').then(setOptions, () => setOptions({ sso: false, email: false }));
  }, []);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>('/api/portal/auth/link', { email });
      setMessage({ kind: 'ok', text: r.message });
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="portal-card portal-signin" aria-labelledby="signin-title">
      <h1 id="signin-title">{TEXT.signInTitle}</h1>
      <p>{TEXT.signInIntro}</p>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {options?.sso && <a className="portal-button primary" href="/api/portal/auth/sso">{TEXT.signInSso}</a>}
      {options?.email && (
        <form onSubmit={send} className="portal-form">
          <label htmlFor="portal-email">{TEXT.signInEmailLabel}</label>
          <input id="portal-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <p className="portal-muted small">{TEXT.signInEmailOnly}</p>
          <button className={`portal-button ${options.sso ? '' : 'primary'}`} disabled={busy}>{TEXT.signInEmailButton}</button>
        </form>
      )}
      {options && !options.sso && !options.email && <p>{TEXT.signInNone}</p>}
    </section>
  );
}

/** The page behind the mailed link: GET shows a button, and only pressing it (POST) signs in, past link scanners. */
export function LinkSignIn({ onDone }: { onDone: () => Promise<unknown> }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [error, setError] = useState('');
  const go = async () => {
    try {
      await api.post('/api/portal/auth/signin', { token });
      await onDone();
      navigate('/portal', { replace: true });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <section className="portal-card portal-signin" aria-labelledby="link-title">
      <h1 id="link-title">{TEXT.linkTitle}</h1>
      {!token ? <p>{TEXT.linkMissing}</p> : <>
        <p>{TEXT.linkIntro}</p>
        {error && <Notice kind="error">{error} <Link to="/portal">{TEXT.signInEmailButton}</Link></Notice>}
        <button type="button" className="portal-button primary" onClick={go}>{TEXT.linkButton}</button>
      </>}
    </section>
  );
}
