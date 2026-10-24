import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { formatDate } from '../format';
import type { Passkey } from '../api/types/settings';

export const passkeysSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential;

/** Signs in (or completes the second factor with mfaToken) with a passkey; returns the signed-in user. */
export async function signInWithPasskey<T>(mfaToken?: string): Promise<T> {
  const options = await api.post<any>('/api/auth/passkey/options', mfaToken ? { mfa_token: mfaToken } : {});
  const response = await startAuthentication({ optionsJSON: options });
  return api.post<T>('/api/auth/passkey/login', { response, ...(mfaToken ? { mfa_token: mfaToken } : {}) });
}

/** Step-up confirmation with a passkey instead of the password. */
export async function confirmWithPasskey() {
  const options = await api.post<any>('/api/auth/reauth/passkey/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  await api.post('/api/auth/reauth/passkey', { response });
}

/** Settings: the account's passkeys. */
export function PasskeysCard() {
  const [items, setItems] = useState<Passkey[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<Passkey[]>('/api/auth/passkeys').then(setItems, () => setItems([])); }, []);
  if (!items) return null;
  const add = async () => {
    setError(null);
    try {
      const options = await api.post<any>('/api/auth/passkeys/options', {});
      const response = await startRegistration({ optionsJSON: options });
      setItems(await api.post<Passkey[]>('/api/auth/passkeys', { response, name: name.trim() || 'Passkey' }));
      setName('');
    } catch (err) {
      setError((err as Error).name === 'NotAllowedError' ? 'Cancelled.' : (err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Passkeys</h2>
      <p className="muted small">Sign in with your device's screen lock or a security key – no password or code needed. A passkey also works as the second factor and to confirm sensitive actions.</p>
      {items.length > 0 && (
        <ul className="plain-list">
          {items.map((p) => (
            <li key={p.id} className="affected">
              <span>{p.name}{p.backed_up && <span className="muted small"> · synced</span>}</span>
              <span className="muted small">added {formatDate(p.created_at)}{p.last_used_at ? ` · last used ${formatDate(p.last_used_at)}` : ''}</span>
              <button className="btn-link danger small" onClick={async () => { if (window.confirm(`Remove the passkey "${p.name}"?`)) setItems(await api.del<Passkey[]>(`/api/auth/passkeys/${p.id}`)); }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {passkeysSupported() ? (
        <div className="rel-form">
          <input placeholder="Name, e.g. Work laptop" value={name} onChange={(e) => setName(e.target.value)} aria-label="Passkey name" />
          <button className="btn" onClick={add}>Add a passkey</button>
        </div>
      ) : <p className="muted small">This browser does not support passkeys.</p>}
      {error && <div className="error small">{error}</div>}
    </section>
  );
}
