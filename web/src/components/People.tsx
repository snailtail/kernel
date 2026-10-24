import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { PersonLite, PersonRef } from '../api/types/people';

/** Find a contact by name or email, or add one inline: "Anna Berg <anna@example.com>", or just an email. */
export function PersonPicker({ placeholder, onPick, exclude = [] }: { placeholder: string; onPick: (p: PersonRef) => void; exclude?: number[] }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PersonLite[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api.get<PersonLite[]>(`/api/people?${new URLSearchParams({ q: q.trim(), limit: '6' })}`).then(setHits, () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (p: PersonRef) => {
    onPick(p);
    setQ('');
  };
  const typed = parseContact(q);
  return (
    <div className="ci-picker">
      <input placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label={placeholder} />
      {q.trim().length >= 2 && (
        <ul className="ci-hits">
          {hits.filter((h) => !exclude.includes(h.id)).map((h) => (
            <li key={h.id}><button type="button" onClick={() => pick({ id: h.id, label: h.name })}>{h.name} {h.is_vip && <span className="vip">VIP</span>} <span className="muted small">{h.email ?? ''}{h.organisation ? ` · ${h.organisation}` : ''}</span></button></li>
          ))}
          {typed && !hits.some((h) => h.email && h.email.toLowerCase() === typed.email?.toLowerCase()) && (
            <li><button type="button" onClick={() => pick(typed)}>+ Add contact <strong>{typed.name}</strong> {typed.email && <span className="muted small">{typed.email}</span>}</button></li>
          )}
        </ul>
      )}
    </div>
  );
}

function parseContact(q: string): { name: string; email?: string } | null {
  const s = q.trim();
  if (s.length < 2) return null;
  const angle = s.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (angle) return { name: angle[1] || angle[2], email: angle[2] };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { name: s, email: s };
  return { name: s };
}

interface WithPeople { ref: string; caller: PersonLite | null; affected_people: PersonLite[]; people_hint: { suggested_impact: number; reason: string } | null; asks_affected_users: boolean }

/** Caller and affected people on an incident. Affected people are only asked for when a service has end users. */
export function IncidentPeoplePanel<T extends WithPeople>({ record: i, basePath, editable, onChange }: { record: T; basePath: string; editable: boolean; onChange: (i: T) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [showAffected, setShowAffected] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChange(await api.get<T>(basePath));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const asks = i.asks_affected_users || showAffected;
  return (
    <section className="card">
      <h2>People</h2>
      <dl className="kv details">
        <dt>Caller</dt>
        <dd>
          {i.caller ? <><Link to={`/people/${i.caller.id}`}>{i.caller.name}</Link> {i.caller.is_vip && <span className="vip">VIP</span>}{i.caller.organisation && <span className="muted small"> · {i.caller.organisation}</span>}</> : '–'}
          {editable && i.caller && <button className="btn-icon small" aria-label="Remove caller" onClick={() => run(() => api.patch(basePath, { caller: null }))}>×</button>}
        </dd>
      </dl>
      {editable && !i.caller && <PersonPicker placeholder="Caller: name or email…" onPick={(p) => run(() => api.patch(basePath, { caller: p }))} />}
      {asks ? (
        <>
          <div className="muted small" style={{ marginTop: 10 }}>Affected people {i.affected_people.length > 0 && `(${i.affected_people.length})`}</div>
          <ul className="plain-list">
            {i.affected_people.map((p) => (
              <li key={p.id} className="affected">
                <Link to={`/people/${p.id}`}>{p.name}</Link> {p.is_vip && <span className="vip">VIP</span>}
                <span className="muted small">{p.organisation ?? ''}</span>
                {editable && <button className="btn-icon small" aria-label={`Remove ${p.name}`} onClick={() => run(() => api.del(`${basePath}/people/${p.id}`))}>×</button>}
              </li>
            ))}
          </ul>
          {editable && <PersonPicker placeholder="Add an affected person…" exclude={i.affected_people.map((p) => p.id)} onPick={(p) => run(() => api.post(`${basePath}/people`, p))} />}
          <p className="muted small">When everyone using a service is affected, link the service instead of listing people.</p>
        </>
      ) : (
        editable && <button type="button" className="link-btn small" onClick={() => setShowAffected(true)}>Record affected people</button>
      )}
      {i.people_hint && (
        <div className="hint-box hint-row">
          {i.people_hint.reason}
          {editable && <button className="btn small" onClick={() => run(() => api.patch(basePath, { impact: i.people_hint!.suggested_impact }))}>Update impact</button>}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

/** A single contact field (service owner, technical contact): shows the chosen person, or a picker that can add one. */
export function PersonField({ value, onChange, placeholder }: { value: { id: number; name: string } | null; onChange: (v: { id: number; name: string } | null) => void; placeholder: string }) {
  const [error, setError] = useState<string | null>(null);
  if (value) return <span className="person-field">{value.name} <button type="button" className="btn-icon small" aria-label={`Clear ${placeholder}`} onClick={() => onChange(null)}>×</button></span>;
  return (
    <>
      <PersonPicker placeholder={placeholder} onPick={async (p) => {
        setError(null);
        try {
          if ('id' in p) {
            const full = await api.get<PersonLite>(`/api/people/${p.id}`);
            onChange({ id: full.id, name: full.name });
          } else {
            const created = await api.post<PersonLite>('/api/people', { name: p.name, email: p.email ?? null });
            onChange({ id: created.id, name: created.name });
          }
        } catch (err) {
          setError((err as Error).message);
        }
      }} />
      {error && <div className="error small">{error}</div>}
    </>
  );
}
