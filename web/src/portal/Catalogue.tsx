import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { TEXT } from './text';
import { errorText, Notice, type CatalogueItem } from './common';

export function Catalogue() {
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
