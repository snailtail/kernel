import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { formatDate, relativeTime } from '../format';
import { useApi } from '../hooks';

interface Held { id: number; received_at: string; from_address: string; from_name: string; subject: string; body: string; verified: boolean; reason: string; ref: string; mailbox: string | null }

/**
 * Inbound email Kernel could not add on its own (#48): a reply from someone who is not verified or takes no part, or
 * one to a closed incident. Nothing from it is in an incident until a person decides.
 */
export function InboundReview() {
  const { data, reload } = useApi<Held[]>('/api/inbound-mail');
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ text: string; ref?: string } | null>(null);
  if (!data?.length) return message ? <p className="hint-box">{message.text}</p> : null;
  const decide = async (m: Held, action: 'incident' | 'comment' | 'discard') => {
    if (action === 'discard' && !confirm(`Discard the email "${m.subject || '(no subject)'}"? Its text is not kept.`)) return;
    setMessage(null);
    try {
      const r = await api.post<{ ref: string | null }>(`/api/inbound-mail/${m.id}/decide`, { action });
      setMessage(action === 'discard' ? { text: 'Discarded.' } : { text: action === 'incident' ? 'Logged as a new incident:' : 'Added as a comment to', ref: r.ref ?? undefined });
    } catch (err) {
      setMessage({ text: (err as Error).message });
    }
    reload();
  };
  return (
    <section className="card">
      <div className="section-head">
        <h2>Inbound email to review <span className="tag">{data.length}</span></h2>
        <button className="btn-link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
      </div>
      <p className="muted small">Replies Kernel did not add on its own, with why. Nothing from them is in an incident until you decide.</p>
      {message && <p className="hint-box">{message.text} {message.ref && <Link to={`/incidents/${message.ref}`} className="mono">{message.ref}</Link>}</p>}
      {open && (
        <ul className="work-list inbound-list">
          {data.map((m) => (
            <li key={m.id}>
              <div>
                <strong>{m.subject || '(no subject)'}</strong> {!m.verified && <span className="tag" title="The receiving mail server did not vouch for the sender">unverified sender</span>}
                <div className="muted small">
                  {m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address} · <span title={formatDate(m.received_at)}>{relativeTime(m.received_at)}</span>
                  {m.mailbox && <> · {m.mailbox}</>} · {m.reason}
                </div>
                {m.body && <details><summary className="small">Text</summary><p className="prose small">{m.body}</p></details>}
              </div>
              <span className="work-meta">
                {m.ref.startsWith('INC') && <button className="btn small" onClick={() => decide(m, 'comment')}>Add to {m.ref}</button>}
                <button className="btn small" onClick={() => decide(m, 'incident')}>New incident</button>
                <button className="btn-link small" onClick={() => decide(m, 'discard')}>Discard</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
