import { useState } from 'react';
import { api } from '../../../api/client';
import { askReason } from '../../../components/Ask';
import { FormModal } from '../../../components/Modal';
import { useApi } from '../../../hooks';
import type { WorkDefinitions } from '../../../api/types/development';

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** A team's Definition of Ready and Definition of Done; managers change them (the change is audited with a reason). */
export function DefinitionsCard({ teamId }: { teamId: number }) {
  const { data, reload } = useApi<WorkDefinitions>(`/api/teams/${teamId}/work-definitions`);
  const [editing, setEditing] = useState(false);
  if (!data) return null;
  const empty = !data.ready.length && !data.done.length;
  return (
    <section className="card wi-defs">
      <h2>How this team works</h2>
      {empty && <p className="placeholder small">No Definition of Ready or Done yet.{data.may_edit ? ' Agree on a few lines with the team; they are shown when an item moves on.' : ''}</p>}
      {!empty && (
        <div className="wi-defs-cols">
          {(['ready', 'done'] as const).map((k) => (
            <div key={k}>
              <h3>Definition of {k === 'ready' ? 'Ready' : 'Done'}</h3>
              {data[k].length ? <ul>{data[k].map((d) => <li key={d}>{d}</li>)}</ul> : <p className="muted small">None.</p>}
            </div>
          ))}
        </div>
      )}
      {data.may_edit && <button className="btn small" onClick={() => setEditing(true)}>Edit</button>}
      {editing && <EditDefinitions d={data} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />}
    </section>
  );
}

function EditDefinitions({ d, onClose, onDone }: { d: WorkDefinitions; onClose: () => void; onDone: () => void }) {
  const [ready, setReady] = useState(d.ready.join('\n'));
  const [done, setDone] = useState(d.done.join('\n'));
  const submit = async () => {
    const reason = await askReason(`Change how ${d.team} works`, 'Say why, for the audit trail: e.g. agreed at the retrospective.', { confirmLabel: 'Save' });
    if (!reason) return;
    await api.put(`/api/teams/${d.team_id}/work-definitions`, { ready: lines(ready), done: lines(done), reason });
    onDone();
  };
  return (
    <FormModal title={`${d.team}: Definition of Ready and Done`} submitLabel="Save" onClose={onClose} onSubmit={submit}
      intro={<p className="muted small">One line each, short and checkable. They guide; nobody is blocked by them.</p>}>
      <label className="full">Definition of Ready<textarea rows={4} value={ready} onChange={(e) => setReady(e.target.value)} placeholder={'Has acceptance criteria\nEstimated'} /></label>
      <label className="full">Definition of Done<textarea rows={4} value={done} onChange={(e) => setDone(e.target.value)} placeholder={'Reviewed\nTested\nDeployed to production'} /></label>
    </FormModal>
  );
}
