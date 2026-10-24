import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api/client';
import { Markdown } from '../components/Markdown';
import { TEXT } from './text';
import { type Ticket, errorText, Notice, type CatalogueItem } from './common';

export function Ask() {
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
