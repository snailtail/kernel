import { useState } from 'react';
import { api } from '../../../api/client';
import { useSession } from '../../../session';

export function CategoriesCard() {
  const { meta, reloadMeta } = useSession();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reloadMeta();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="card">
      <h2>Categories</h2>
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/categories', { name })).then(() => setName('')); }}>
        <input required placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary">Add</button>
      </form>
      {error && <div className="error">{error}</div>}
      <ul className="chip-list">
        {meta.categories.map((c) => (
          <li key={c.id} className={c.active ? '' : 'inactive'}>
            {c.name}
            <button className="btn-link small" onClick={() => run(() => api.patch(`/api/categories/${c.id}`, { active: !c.active }))}>
              {c.active ? 'Disable' : 'Enable'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
