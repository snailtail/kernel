import { useState } from 'react';
import { api } from '../../../api/client';
import { ROLE_LABEL } from '../../../format';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import { StartPageSelects, type StartChoice } from '../../../components/StartPage';

const PERSON_ROLES = ['admin', 'manager', 'analyst', 'viewer'] as const;
type RoleDefaults = Partial<Record<(typeof PERSON_ROLES)[number], StartChoice>>;

/** Where each role starts until a person chooses for themselves (#171). */
export function StartPagesCard() {
  const { meta } = useSession();
  const { data, setData } = useApi<RoleDefaults>('/api/admin/start-pages');
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const save = async (role: (typeof PERSON_ROLES)[number], c: StartChoice) => {
    setError(null);
    try {
      setData(await api.put<RoleDefaults>('/api/admin/start-pages', { [role]: c }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Start page per role</h2>
      <p className="muted small">Where people start and what "+ New" creates first, until they choose for themselves in Settings. Kernel favours no practice: without a choice here people start on My work, and "+ New" creates an incident (a problem when incidents are off).</p>
      <div className="role-starts">
        {PERSON_ROLES.map((r) => (
          <div key={r} className="pref-row">
            <strong>{ROLE_LABEL[r]}</strong>
            <StartPageSelects value={data[r] ?? {}} meta={meta} creates={r !== 'viewer'} inherit={{ home: 'My work (default)', default_new: `${meta.modules?.incident !== false ? 'Incident' : 'Problem'} (default)` }} onChange={(c) => save(r, c)} />
          </div>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
