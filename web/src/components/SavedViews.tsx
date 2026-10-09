import { useSearchParams } from 'react-router';
import { useSession } from '../session';
import { askText } from './Ask';

/** Saved filters for a list page, stored in the user's preferences. */
export function SavedViews({ page }: { page: 'problems' | 'actions' }) {
  const { user, setPreferences } = useSession();
  const [params, setParams] = useSearchParams();
  const all = user.preferences.saved_views ?? [];
  const views = all.filter((v) => v.page === page);
  const current = params.toString();

  const save = async () => {
    const name = await askText('Save view', 'Name', { message: 'Saves the current filters and sorting as a view you can open with one click.' });
    if (!name) return;
    await setPreferences({ saved_views: [...all.filter((v) => !(v.page === page && v.name === name)), { name, page, query: current }] });
  };
  const remove = (name: string) => setPreferences({ saved_views: all.filter((v) => !(v.page === page && v.name === name)) });

  return (
    <div className="saved-views">
      {views.map((v) => (
        <span key={v.name} className={`view-chip ${v.query === current ? 'on' : ''}`}>
          <button onClick={() => setParams(new URLSearchParams(v.query), { replace: true })}>{v.name}</button>
          <button className="remove" aria-label={`Remove view ${v.name}`} onClick={() => remove(v.name)}>×</button>
        </span>
      ))}
      {current && !views.some((v) => v.query === current) && <button className="btn-link small" onClick={save}>+ Save view</button>}
    </div>
  );
}
