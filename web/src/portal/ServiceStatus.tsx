import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { NEWS_PHASE, SERVICE_STATE, TEXT } from './text';
import { when, errorText, Notice } from './common';

interface StatusPage { services: { name: string; description: string; status: string }[]; updates: { phase: string; status: string | null; message: string; created_at: string; services: string[] }[]; sign_up: boolean }

export function ServiceStatus() {
  const [page, setPage] = useState<StatusPage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    api.get<StatusPage>('/api/portal/status').then(setPage, (err) => setError(errorText(err)));
  }, []);
  const signUp = async () => {
    try {
      await api.post('/api/portal/status/subscribe');
      setNotice(TEXT.statusSignedUp);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <>
      <p><Link to="/portal">← {TEXT.back}</Link></p>
      <h1>{TEXT.statusTitle}</h1>
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}
      {!page ? !error && <p className="portal-muted" role="status">{TEXT.loading}</p> : !page.services.length ? <p className="portal-muted">{TEXT.statusNone}</p> : <>
        <ul className="portal-services">
          {page.services.map((s) => (
            <li key={s.name}>
              <span><strong>{s.name}</strong>{s.description && <span className="portal-muted small"> {s.description}</span>}</span>
              <span className={`portal-status svc-${s.status}`}>{SERVICE_STATE[s.status] ?? s.status}</span>
            </li>
          ))}
        </ul>
        <section aria-labelledby="news-title">
          <h2 id="news-title">{TEXT.statusNews}</h2>
          {!page.updates.length ? <p className="portal-muted">{TEXT.statusNoNews}</p> : (
            <ol className="portal-messages">
              {page.updates.map((u, i) => (
                <li key={i}>
                  <p className="portal-muted small"><strong>{NEWS_PHASE[u.phase] ?? u.phase}</strong> · {u.services.join(', ')} · <time dateTime={u.created_at}>{when(u.created_at)}</time></p>
                  <p>{u.message}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
        {page.sign_up && !notice && <button type="button" className="portal-button portal-spaced" onClick={signUp}>{TEXT.statusSignUp}</button>}
      </>}
    </>
  );
}
