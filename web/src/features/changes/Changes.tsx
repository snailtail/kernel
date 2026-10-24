import { useState } from 'react';
import { useNavigate } from 'react-router';
import { SavedViews } from '../../components/SavedViews';
import { useListParams, useOpenOnNew } from '../../hooks';
import { useSession } from '../../session';
import { ChangeList } from './components/ChangeList';
import { Schedule } from './components/Schedule';
import { Templates } from './components/Templates';
import { Freezes } from './components/Freezes';
import { NewChange } from './components/NewChange';

export function ChangesPage() {
  const { user } = useSession();
  const { params, setParams, set } = useListParams();
  const tab = params.get('tab') ?? 'list';
  const [creating, setCreating] = useState(false);
  useOpenOnNew(() => setCreating(true));
  const navigate = useNavigate();
  const manager = user.role === 'admin' || user.role === 'manager';
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Changes</h1>
          <p className="muted">Assess the risk, authorise, schedule without collisions or freezes, and review.</p>
        </div>
        {tab === 'list' && <SavedViews list="changes" />}
        {user.role !== 'viewer' && <button className="btn primary page-new" onClick={() => setCreating(true)}>New change</button>}
      </header>
      <div className="seg-toggle tabs" role="tablist">
        {[['list', 'Changes'], ['schedule', 'Schedule'], ['templates', 'Standard changes'], ['freezes', 'Freezes']].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setParams({ tab: id }, { replace: true })}>{label}</button>
        ))}
      </div>
      {tab === 'list' && <ChangeList params={params} set={set} />}
      {tab === 'schedule' && <Schedule />}
      {tab === 'templates' && <Templates manager={manager} />}
      {tab === 'freezes' && <Freezes manager={manager} />}
      {creating && <NewChange onClose={() => setCreating(false)} onDone={(ref) => navigate(`/changes/${ref}`)} />}
    </>
  );
}
