import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { api, ApiError } from '../api/client';
import { Markdown } from '../components/Markdown';
import { RATINGS, TEXT } from './text';
import { type Ticket, when, errorText, tone, Notice } from './common';
import './styles.css';

export function TicketPage() {
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
