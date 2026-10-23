import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api';
import { useApi } from '../hooks';
import { useTeams } from '../pages/Teams';
import { isManager, useSession } from '../session';
import { columnStore } from './ListToolkit';
import { Modal } from './Modal';

export type ListName = 'problems' | 'actions' | 'incidents' | 'changes' | 'alerts' | 'known_errors' | 'knowledge' | 'cis' | 'candidates' | 'improvements' | 'requests';

export interface ListView {
  key: string;
  id: number | null;
  name: string;
  scope: 'builtin' | 'personal' | 'team' | 'everyone';
  team_id: number | null;
  team: string | null;
  query: string;
  columns: string[];
  can_edit: boolean;
  is_default: boolean;
}

const SCOPE_HINT: Record<ListView['scope'], string> = {
  builtin: 'Built-in view',
  personal: 'Only you see this view',
  team: 'Shared with a team',
  everyone: 'Shared with everyone',
};

/** Same filters, whatever order the parameters are in. The page's tab is where the list is, not a filter. */
const normal = (q: string) => [...new URLSearchParams(q)].filter(([k]) => k !== 'tab').map(([k, v]) => `${k}=${v}`).sort().join('&');
const withoutTab = (params: URLSearchParams) => new URLSearchParams([...params].filter(([k]) => k !== 'tab')).toString();

/**
 * Saved views for a list page (#110): built-in queues, the user's own, their teams' and everyone's. A view is the
 * list's query string; one view can be pinned as the default the list opens with.
 */
export function SavedViews({ list }: { list: ListName }) {
  const [params, setParams] = useSearchParams();
  const { data, reload } = useApi<{ views: ListView[]; default: string | null }>(`/api/views?list=${list}`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = normal(params.toString());
  const views = data?.views ?? [];
  const active = views.find((v) => normal(v.query) === current && (v.query !== '' || current === ''));

  // Open the list with the pinned view, unless the address already says what to show.
  const applied = useRef(false);
  useEffect(() => {
    if (!data || applied.current) return;
    applied.current = true;
    const pinned = data.views.find((v) => v.key === data.default);
    if (pinned?.query && withoutTab(params) === '') setParams(new URLSearchParams(pinned.query), { replace: true });
    if (pinned?.columns.length) columnStore.set(list, pinned.columns);
  }, [data, params, setParams]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = (v: ListView) => {
    if (v.scope !== 'personal' && !window.confirm(`Remove "${v.name}" for everyone who shares it?`)) return;
    run(() => api.del(`/api/views/${v.id}`));
  };
  const pin = (v: ListView) => run(() => api.put('/api/views/default', { list, view: v.is_default ? null : v.id ?? v.key }));

  return (
    <div className="saved-views">
      {views.map((v) => (
        <span key={v.key} className={`view-chip ${v.scope} ${v === active ? 'on' : ''}`} title={v.team ? `${SCOPE_HINT[v.scope]}: ${v.team}` : SCOPE_HINT[v.scope]}>
          <button onClick={() => { setParams(new URLSearchParams(v.query), { replace: true }); if (v.columns.length) columnStore.set(list, v.columns); }} aria-pressed={v === active}>
            {v.is_default && <span aria-label="Default view">★ </span>}
            {v.name}
            {v.scope === 'team' && <span className="view-scope"> · {v.team}</span>}
            {v.scope === 'everyone' && <span className="view-scope"> · everyone</span>}
          </button>
          {v === active && (
            <button className="pin" onClick={() => pin(v)} aria-label={v.is_default ? `Stop opening the list with ${v.name}` : `Open the list with ${v.name}`} title={v.is_default ? 'Stop using as default' : 'Make this my default'}>
              {v.is_default ? '★' : '☆'}
            </button>
          )}
          {v.can_edit && <button className="remove" aria-label={`Remove view ${v.name}`} onClick={() => remove(v)}>×</button>}
        </span>
      ))}
      {current && !active && <button className="btn-link small" onClick={() => setSaving(true)}>+ Save view</button>}
      {error && <span className="error small" role="alert">{error}</span>}
      {saving && (
        <SaveView
          list={list}
          query={withoutTab(params)}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

/** The query as people read it: "status = all · q = printer". */
const describeQuery = (query: string) =>
  [...new URLSearchParams(query)].map(([k, v]) => `${k.replace(/_/g, ' ')} = ${v}`).join(' · ') || 'no filters';

function SaveView({ list, query, onClose, onSaved }: { list: ListName; query: string; onClose: () => void; onSaved: () => void }) {
  const { user } = useSession();
  const teams = useTeams();
  const [name, setName] = useState('');
  const [share, setShare] = useState('personal');
  const [error, setError] = useState<string | null>(null);
  // Leads share with their own teams; administrators with any team.
  const shareable = teams.filter((t) => t.active && (user.role === 'admin' || t.members.some((m) => m.user_id === user.id && m.role === 'lead')));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const scope = share.startsWith('team:') ? 'team' : share;
    try {
      await api.post('/api/views', { list, name: name.trim(), query, columns: columnStore.get(list), scope, team_id: scope === 'team' ? Number(share.slice(5)) : null });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="Save view" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint full">Saves the current filters and sorting as a view you can open with one click.</p>
        <label className="full">
          Name
          <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="full">
          Who sees it
          <select value={share} onChange={(e) => setShare(e.target.value)}>
            <option value="personal">Only me</option>
            {shareable.map((t) => <option key={t.id} value={`team:${t.id}`}>Team {t.name}</option>)}
            {isManager(user) && <option value="everyone">Everyone</option>}
          </select>
        </label>
        {share !== 'personal' && (
          <div className="hint full">
            <p>
              {share === 'everyone' ? 'Everyone' : `Everyone in ${shareable.find((t) => `team:${t.id}` === share)?.name ?? 'the team'}`} will see these filters, search text included:
            </p>
            <code className="view-query">{describeQuery(query)}</code>
            <p>A shared view belongs to {share === 'everyone' ? 'everyone: managers can change it' : 'the team: its leads can change it'}.</p>
          </div>
        )}
        {error && <div className="error full" role="alert">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()}>Save view</button>
        </div>
      </form>
    </Modal>
  );
}
