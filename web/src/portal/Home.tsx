import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { TEXT } from './text';
import { type Me, type Ticket, when, errorText, tone, Notice } from './common';
import './styles.css';

export function Home({ me }: { me: Me }) {
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
