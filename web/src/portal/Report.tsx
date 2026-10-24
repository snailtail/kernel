import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import { AFFECTED, TEXT } from './text';
import { type Ticket, errorText, Notice } from './common';
import './styles.css';

export function Report() {
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
