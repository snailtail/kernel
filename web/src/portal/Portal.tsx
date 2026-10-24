// The self-service portal (#45): a small, friendly front door for people outside IT, mobile first. It talks only to
// /api/portal/* with its own session; nothing from Kernel's own UI is loaded here.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '../api/client';
import { Markdown } from '../components/Markdown';
import { AFFECTED, NEWS_PHASE, RATINGS, SERVICE_STATE, TEXT } from './text';

interface Me { name: string; report_problem: boolean; requests: boolean; status: boolean }
interface Update { at: string; from: 'you' | 'it'; by: string; body: string }
interface Ticket {
  kind: 'problem_report' | 'request';
  ref: string;
  title: string | null;
  status: string;
  status_label: string;
  handled_by: string;
  created_at: string;
  updated_at: string;
  can: { add_information: boolean; confirm: boolean; rate: boolean };
  rating: 'good' | 'okay' | 'bad' | null;
  updates?: Update[];
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const errorText = (err: unknown) => (err instanceof ApiError ? err.message : TEXT.error);
const tone = (t: Ticket) => (['closed', 'fulfilled', 'cancelled', 'rejected'].includes(t.status) ? 'done' : t.status === 'resolved' ? 'solved' : t.status === 'on_hold' || t.status === 'awaiting_approval' ? 'waiting' : 'open');

export function PortalApp() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = useCallback(() => api.get<Me>('/api/portal/me').then(setMe, () => setMe(null)), []);
  useEffect(() => {
    document.title = TEXT.appName;
    load();
  }, [load]);
  const signOut = async () => {
    await api.post('/api/portal/auth/logout').catch(() => {});
    setMe(null);
  };

  return (
    <div className="portal">
      <a className="skip-link" href="#portal-main">{TEXT.skip}</a>
      <header className="portal-header">
        <Link to="/portal" className="portal-brand">{TEXT.appName}</Link>
        {me && <button type="button" className="portal-link-button" onClick={signOut}>{TEXT.signOut}</button>}
      </header>
      <main id="portal-main" className="portal-main" tabIndex={-1}>
        {me === undefined ? <p className="portal-muted" role="status">{TEXT.loading}</p> : (
          <Routes>
            <Route path="/portal/signin" element={<LinkSignIn onDone={load} />} />
            {me === null ? <Route path="*" element={<SignIn />} /> : <>
              <Route path="/portal" element={<Home me={me} />} />
              <Route path="/portal/report" element={<Report />} />
              <Route path="/portal/ask" element={<Catalogue />} />
              <Route path="/portal/ask/:id" element={<Ask />} />
              <Route path="/portal/status" element={<ServiceStatus />} />
              <Route path="/portal/tickets/:ref" element={<TicketPage />} />
              <Route path="/portal/help/:ref" element={<Article />} />
              <Route path="*" element={<p>{TEXT.notFound} <Link to="/portal">{TEXT.back}</Link></p>} />
            </>}
          </Routes>
        )}
      </main>
    </div>
  );
}

/** A focused message for screen readers when something happens (sent, saved, failed). */
function Notice({ kind, children }: { kind: 'ok' | 'error'; children: ReactNode }) {
  return <p className={`portal-notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</p>;
}

function SignIn() {
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
function LinkSignIn({ onDone }: { onDone: () => Promise<unknown> }) {
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

function Home({ me }: { me: Me }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<Ticket[]>('/api/portal/tickets').then(setTickets, (err) => setError(errorText(err)));
  }, []);
  return (
    <>
      <h1>{TEXT.hello(me.name)}</h1>
      {me.report_problem && (
        <Link to="/portal/report" className="portal-action">
          <strong>{TEXT.reportButton}</strong>
          <span>{TEXT.reportHint}</span>
        </Link>
      )}
      {me.requests && (
        <Link to="/portal/ask" className="portal-action secondary">
          <strong>{TEXT.askButton}</strong>
          <span>{TEXT.askHint}</span>
        </Link>
      )}
      {me.status && (
        <Link to="/portal/status" className="portal-action secondary">
          <strong>{TEXT.statusButton}</strong>
          <span>{TEXT.statusHint}</span>
        </Link>
      )}
      <section aria-labelledby="tickets-title">
        <h2 id="tickets-title">{TEXT.myTickets}</h2>
        {error && <Notice kind="error">{error}</Notice>}
        {tickets === null ? !error && <p className="portal-muted" role="status">{TEXT.loading}</p>
          : !tickets.length ? <p className="portal-muted">{TEXT.noTickets}</p>
          : (
            <ul className="portal-tickets">
              {tickets.map((t) => (
                <li key={t.ref}>
                  <Link to={`/portal/tickets/${t.ref}`}>
                    <span className="portal-ticket-title">{t.title ?? t.ref}</span>
                    <span className={`portal-status ${tone(t)}`}>{t.status_label}</span>
                    <span className="portal-muted small">{t.ref} · {TEXT.updated} {when(t.updated_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </section>
    </>
  );
}

function Report() {
  const navigate = useNavigate();
  const [services, setServices] = useState<{ ref: string; name: string }[]>([]);
  const [service, setService] = useState('');
  const [what, setWhat] = useState('');
  const [affected, setAffected] = useState<'me' | 'some' | 'many'>('me');
  const [suggestions, setSuggestions] = useState<{ ref: string; title: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ ref: string; name: string }[]>('/api/portal/services').then(setServices, () => setServices([]));
  }, []);
  // Help articles for what they type, after a short pause.
  useEffect(() => {
    if (what.trim().length < 4) return setSuggestions([]);
    const t = setTimeout(() => api.get<{ ref: string; title: string }[]>(`/api/portal/suggestions?q=${encodeURIComponent(what.slice(0, 300))}`).then(setSuggestions, () => {}), 400);
    return () => clearTimeout(t);
  }, [what]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const t = await api.post<Ticket>('/api/portal/problems', { service: service || null, what, affected });
      navigate(`/portal/tickets/${t.ref}`, { state: { sent: 'problem' } });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <>
      <p><Link to="/portal">← {TEXT.back}</Link></p>
      <h1>{TEXT.reportTitle}</h1>
      <form className="portal-card portal-form" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        {services.length > 0 && <>
          <label htmlFor="portal-service">{TEXT.serviceLabel}</label>
          <select id="portal-service" value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">{TEXT.serviceUnknown}</option>
            {services.map((s) => <option key={s.ref} value={s.ref}>{s.name}</option>)}
          </select>
        </>}
        <label htmlFor="portal-what">{TEXT.whatLabel}</label>
        <textarea id="portal-what" rows={6} required minLength={5} maxLength={5000} value={what} onChange={(e) => setWhat(e.target.value)} aria-describedby="portal-what-hint" />
        <p id="portal-what-hint" className="portal-muted small">{TEXT.whatHint}</p>
        {suggestions.length > 0 && (
          <aside className="portal-suggestions" aria-labelledby="suggestions-title" aria-live="polite">
            <h2 id="suggestions-title">{TEXT.suggestionsTitle}</h2>
            <ul>{suggestions.map((a) => <li key={a.ref}><Link to={`/portal/help/${a.ref}`}>{a.title}</Link></li>)}</ul>
          </aside>
        )}
        <fieldset>
          <legend>{TEXT.affectedLegend}</legend>
          {AFFECTED.map((a) => (
            <label key={a.value} className="portal-choice">
              <input type="radio" name="affected" value={a.value} checked={affected === a.value} onChange={() => setAffected(a.value)} /> {a.label}
            </label>
          ))}
        </fieldset>
        <button className="portal-button primary" disabled={busy || what.trim().length < 5}>{busy ? TEXT.sending : TEXT.send}</button>
      </form>
    </>
  );
}

function TicketPage() {
  const { ref = '' } = useParams();
  const location = useLocation();
  const [t, setT] = useState<Ticket | null>(null);
  const [error, setError] = useState('');
  const sent = (location.state as { sent?: 'problem' | 'request' } | null)?.sent;
  const [notice, setNotice] = useState<string>(sent === 'request' ? TEXT.askSent : sent ? TEXT.sent : '');
  const [info, setInfo] = useState('');
  const [still, setStill] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    api.get<Ticket>(`/api/portal/tickets/${ref}`).then(setT, (err) => setError(err instanceof ApiError && err.status === 404 ? TEXT.notFound : errorText(err)));
  }, [ref]);
  useEffect(() => {
    if (t) heading.current?.focus();
  }, [t?.ref]);
  const act = async (fn: () => Promise<Ticket>, done: string) => {
    setError('');
    try {
      setT(await fn());
      setNotice(done);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };
  if (!t) return <>{error ? <Notice kind="error">{error}</Notice> : <p className="portal-muted" role="status">{TEXT.loading}</p>}<p><Link to="/portal">← {TEXT.back}</Link></p></>;
  return (
    <>
      <p><Link to="/portal">← {TEXT.back}</Link></p>
      <h1 ref={heading} tabIndex={-1}>{t.title ?? t.ref}</h1>
      <p className="portal-meta">
        <span className={`portal-status ${tone(t)}`}>{t.status_label}</span>
        <span className="portal-muted small">{t.ref} · {TEXT.reported} {when(t.created_at)} · {TEXT.handledBy} {t.handled_by}</span>
      </p>
      {notice && <Notice kind="ok">{notice}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {t.can.confirm && (
        <section className="portal-card portal-confirm" aria-labelledby="confirm-title">
          <h2 id="confirm-title">{TEXT.confirmQuestion}</h2>
          {still === null ? (
            <div className="portal-buttons">
              <button type="button" className="portal-button primary" onClick={() => act(() => api.post<Ticket>(`/api/portal/tickets/${t.ref}/confirm`, { works: true }), TEXT.thanksWorks)}>{TEXT.works}</button>
              <button type="button" className="portal-button" onClick={() => setStill('')}>{TEXT.stillProblem}</button>
            </div>
          ) : (
            <form className="portal-form" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api.post<Ticket>(`/api/portal/tickets/${t.ref}/confirm`, { works: false, body: still }), TEXT.thanksReopened)) setStill(null); }}>
              <label htmlFor="portal-still">{TEXT.stillProblemLabel}</label>
              <textarea id="portal-still" rows={3} maxLength={5000} value={still} onChange={(e) => setStill(e.target.value)} />
              <button className="portal-button primary">{TEXT.stillProblem}</button>
            </form>
          )}
        </section>
      )}
      {t.can.rate && <Rate ticket={t} onDone={(n) => { setT(n); setNotice(TEXT.rateThanks); }} />}
      {t.rating && <p className="portal-muted">{TEXT.rated(RATINGS.find((r) => r.value === t.rating)?.label ?? t.rating)}</p>}
      <section aria-labelledby="messages-title">
        <h2 id="messages-title">{TEXT.conversation}</h2>
        {t.title === null ? <p className="portal-muted">{TEXT.restricted}</p>
          : !t.updates?.length ? <p className="portal-muted">{TEXT.noMessages}</p>
          : (
            <ol className="portal-messages">
              {t.updates.map((u, i) => (
                <li key={i} className={u.from}>
                  <p className="portal-muted small"><strong>{u.from === 'you' ? TEXT.you : u.by}</strong> · <time dateTime={u.at}>{when(u.at)}</time></p>
                  <Markdown text={u.body} />
                </li>
              ))}
            </ol>
          )}
      </section>
      {t.can.add_information ? (
        <form className="portal-card portal-form" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api.post<Ticket>(`/api/portal/tickets/${t.ref}/messages`, { body: info }), '')) setInfo(''); }}>
          <label htmlFor="portal-info">{TEXT.addInfoLabel}</label>
          <textarea id="portal-info" rows={3} maxLength={5000} value={info} onChange={(e) => setInfo(e.target.value)} aria-describedby="portal-info-hint" />
          <p id="portal-info-hint" className="portal-muted small">{TEXT.addInfoHint}</p>
          <button className="portal-button primary" disabled={!info.trim()}>{TEXT.addInfoButton}</button>
        </form>
      ) : <p className="portal-muted">{TEXT.closedNote} <Link to="/portal/report">{TEXT.reportButton}</Link></p>}
    </>
  );
}

function Article() {
  const { ref = '' } = useParams();
  const [a, setA] = useState<{ title: string; body: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<{ title: string; body: string }>(`/api/portal/articles/${ref}`).then(setA, () => setError(TEXT.notFound));
  }, [ref]);
  return (
    <>
      <p><Link to="/portal/report">← {TEXT.back}</Link></p>
      {error ? <Notice kind="error">{error}</Notice> : !a ? <p className="portal-muted" role="status">{TEXT.loading}</p> : (
        <article className="portal-card">
          <h1>{a.title}</h1>
          <Markdown text={a.body} />
          <p className="portal-muted">{TEXT.articleFooter} <Link to="/portal/report">{TEXT.reportButton}</Link></p>
        </article>
      )}
    </>
  );
}

/** One click on how it went, once it is closed; a comment is optional. */
function Rate({ ticket, onDone }: { ticket: Ticket; onDone: (t: Ticket) => void }) {
  const [rating, setRating] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const send = async (value: string, text: string) => {
    try {
      onDone(await api.post<Ticket>(`/api/portal/tickets/${ticket.ref}/rating`, { rating: value, comment: text }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <section className="portal-card portal-rate" aria-labelledby="rate-title">
      <h2 id="rate-title">{TEXT.rateQuestion}</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="portal-buttons" role="group" aria-labelledby="rate-title">
        {RATINGS.map((r) => (
          <button key={r.value} type="button" className={`portal-button portal-face ${rating === r.value ? 'on' : ''}`} aria-pressed={rating === r.value} onClick={() => setRating(r.value)}>
            <span aria-hidden="true">{r.face}</span> {r.label}
          </button>
        ))}
      </div>
      {rating && (
        <form className="portal-form" onSubmit={(e) => { e.preventDefault(); send(rating, comment); }}>
          <label htmlFor="portal-rate-comment">{TEXT.rateComment}</label>
          <textarea id="portal-rate-comment" rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          <button className="portal-button primary">{TEXT.rateSend}</button>
        </form>
      )}
    </section>
  );
}

interface CatalogueItem { id: number; name: string; description: string; needs_approval: boolean; service: string | null; form?: { key: string; label: string; type: 'text' | 'textarea' | 'choice' | 'date'; required: boolean; choices: string[] }[] }

function Catalogue() {
  const [items, setItems] = useState<CatalogueItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<CatalogueItem[]>('/api/portal/catalogue').then(setItems, (err) => setError(errorText(err)));
  }, []);
  const groups = new Map<string, CatalogueItem[]>();
  for (const i of items ?? []) groups.set(i.service ?? TEXT.askOther, [...(groups.get(i.service ?? TEXT.askOther) ?? []), i]);
  return (
    <>
      <p><Link to="/portal">← {TEXT.back}</Link></p>
      <h1>{TEXT.askTitle}</h1>
      {error && <Notice kind="error">{error}</Notice>}
      {items === null ? !error && <p className="portal-muted" role="status">{TEXT.loading}</p>
        : !items.length ? <p className="portal-muted">{TEXT.askEmpty}</p>
        : [...groups].map(([service, list]) => (
          <section key={service} aria-label={service}>
            <h2>{service}</h2>
            <ul className="portal-tickets">
              {list.map((i) => (
                <li key={i.id}>
                  <Link to={`/portal/ask/${i.id}`}>
                    <span className="portal-ticket-title">{i.name}</span>
                    {i.needs_approval ? <span className="portal-status waiting">{TEXT.needsApproval}</span> : <span />}
                    {i.description && <span className="portal-muted small">{i.description.split('\n')[0]}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}

function Ask() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<CatalogueItem | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<CatalogueItem>(`/api/portal/catalogue/${id}`).then(setItem, (err) => setError(err instanceof ApiError && err.status === 404 ? TEXT.notFound : errorText(err)));
  }, [id]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
      const t = await api.post<Ticket>('/api/portal/requests', { item_id: Number(id), answers: filled });
      navigate(`/portal/tickets/${t.ref}`, { state: { sent: 'request' } });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  if (!item) return <>{error ? <Notice kind="error">{error}</Notice> : <p className="portal-muted" role="status">{TEXT.loading}</p>}<p><Link to="/portal/ask">← {TEXT.back}</Link></p></>;
  const set = (key: string, value: string) => setAnswers((a) => ({ ...a, [key]: value }));
  return (
    <>
      <p><Link to="/portal/ask">← {TEXT.back}</Link></p>
      <h1>{item.name}</h1>
      {item.description && <Markdown text={item.description} />}
      {item.needs_approval && <p className="portal-muted">{TEXT.needsApproval}</p>}
      <form className="portal-card portal-form" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        {item.form!.map((f) => {
          const fid = `portal-f-${f.key}`;
          const label = <label htmlFor={fid}>{f.label} {!f.required && <span className="portal-muted">{TEXT.optional}</span>}</label>;
          const value = answers[f.key] ?? '';
          return (
            <div key={f.key} className="portal-field">
              {label}
              {f.type === 'textarea' ? <textarea id={fid} rows={4} required={f.required} maxLength={10000} value={value} onChange={(e) => set(f.key, e.target.value)} />
                : f.type === 'choice' ? (
                  <select id={fid} required={f.required} value={value} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="">{TEXT.choose}</option>
                    {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )
                : <input id={fid} type={f.type === 'date' ? 'date' : 'text'} required={f.required} maxLength={500} value={value} onChange={(e) => set(f.key, e.target.value)} />}
            </div>
          );
        })}
        <button className="portal-button primary" disabled={busy}>{busy ? TEXT.sending : TEXT.askSend}</button>
      </form>
    </>
  );
}

interface StatusPage { services: { name: string; description: string; status: string }[]; updates: { phase: string; status: string | null; message: string; created_at: string; services: string[] }[]; sign_up: boolean }

function ServiceStatus() {
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
