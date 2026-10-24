import { useSearchParams } from 'react-router';
import type { Action } from '../api';
import { ActionList } from '../components/Actions';
import { SavedViews } from '../components/SavedViews';
import { useListToolkit } from '../components/list/ListToolkit';
import { useApi, useSearchText } from '../hooks';
import { canEdit, useSession } from '../session';

export function ActionsPage() {
  const { user, meta } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useSearchText();
  const setParam = (key: string, value: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });


  const query = new URLSearchParams(params);
  // Mine by default, unless the link is to the actions of one bulk change.
  if (!query.has('owner_id') && !params.has('everyone') && !params.has('bulk')) query.set('owner_id', String(user.id));
  query.delete('everyone');
  const { data, reload } = useApi<Action[]>(`/api/actions?${query}`);
  const tk = useListToolkit({ list: 'actions', rows: data, idOf: (a) => String(a.id), hrefOf: (a) => a.path, filter: query.toString(), onChanged: reload });
  const owner = params.get('owner_id') ?? (params.has('everyone') || params.has('bulk') ? '' : String(user.id));

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Follow-up actions</h1>
          <p className="muted">Work that follows from problems, incidents and their reviews, changes, requests and improvements.</p>
        </div>
        <SavedViews list="actions" />
      </header>
      <div className="filters">
        <input className="search" placeholder="Search actions or records…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={params.get('status') ?? 'open'} onChange={(e) => setParam('status', e.target.value === 'open' ? '' : e.target.value)}>
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
        <select
          value={owner}
          onChange={(e) =>
            setParams((prev) => {
              const next = new URLSearchParams(prev);
              next.delete('owner_id');
              next.delete('everyone');
              if (e.target.value === '') next.set('everyone', '1');
              else if (e.target.value !== String(user.id)) next.set('owner_id', e.target.value);
              return next;
            }, { replace: true })
          }
        >
          <option value={String(user.id)}>Mine</option>
          <option value="">Everyone</option>
          {meta.assignees.filter((a) => a.id !== user.id).map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
        </select>
        <label className="check">
          <input type="checkbox" checked={params.get('overdue') === 'true'} onChange={(e) => setParam('overdue', e.target.checked ? 'true' : '')} />
          Overdue only
        </label>
      </div>
      {tk.scope}
      <section className="card">
        {data?.length === 0 && <p className="empty">No actions match.</p>}
        {data && <ActionList actions={data} editable={canEdit(user)} showParent onChange={() => reload()} toolkit={tk} />}
      </section>
      {tk.bar}
    </>
  );
}
