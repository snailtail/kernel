import { useState } from 'react';
import { api } from '../../../api/client';
import { askReason } from '../../../components/Ask';
import { FormModal } from '../../../components/Modal';
import { useApi } from '../../../hooks';
import { WORK_ITEM_STATUS } from '../../../statuses';
import type { BoardColumn, WorkDefinitions } from '../../../api/types/development';

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

const COLUMNS: BoardColumn[] = ['new', 'ready', 'in_progress', 'in_review', 'done'];

/** A team's Definition of Ready and Done and its WIP limits; managers change them (the change is audited with a reason). */
export function DefinitionsCard({ teamId }: { teamId: number }) {
  const { data, reload } = useApi<WorkDefinitions>(`/api/teams/${teamId}/work-definitions`);
  const [editing, setEditing] = useState(false);
  if (!data) return null;
  const empty = !data.ready.length && !data.done.length;
  const limits = COLUMNS.filter((c) => data.wip_limits[c]);
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
      {limits.length > 0 && <p className="muted small">WIP limits: {limits.map((c) => `${WORK_ITEM_STATUS[c]} ${data.wip_limits[c]}`).join(' · ')}</p>}
      {data.may_edit && <button className="btn small" onClick={() => setEditing(true)}>Edit</button>}
      {editing && <EditDefinitions d={data} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />}
    </section>
  );
}

function EditDefinitions({ d, onClose, onDone }: { d: WorkDefinitions; onClose: () => void; onDone: () => void }) {
  const [ready, setReady] = useState(d.ready.join('\n'));
  const [done, setDone] = useState(d.done.join('\n'));
  const [limits, setLimits] = useState<Partial<Record<BoardColumn, string>>>(Object.fromEntries(Object.entries(d.wip_limits).map(([k, v]) => [k, String(v)])));
  const submit = async () => {
    const reason = await askReason(`Change how ${d.team} works`, 'Say why, for the audit trail: e.g. agreed at the retrospective.', { confirmLabel: 'Save' });
    if (!reason) return;
    const wip_limits = Object.fromEntries(Object.entries(limits).filter(([, v]) => v && Number(v) > 0).map(([k, v]) => [k, Number(v)]));
    await api.put(`/api/teams/${d.team_id}/work-definitions`, { ready: lines(ready), done: lines(done), wip_limits, reason });
    onDone();
  };
  return (
    <FormModal title={`How ${d.team} works`} submitLabel="Save" onClose={onClose} onSubmit={submit}
      intro={<p className="muted small">One line each, short and checkable. They guide; nobody is blocked by them.</p>}>
      <label className="full">Definition of Ready<textarea rows={4} value={ready} onChange={(e) => setReady(e.target.value)} placeholder={'Has acceptance criteria\nEstimated'} /></label>
      <label className="full">Definition of Done<textarea rows={4} value={done} onChange={(e) => setDone(e.target.value)} placeholder={'Reviewed\nTested\nDeployed to production'} /></label>
      <fieldset className="full wi-wip">
        <legend>WIP limits on the board <span className="muted small">(a warning when a column holds more; empty for none)</span></legend>
        {(['ready', 'in_progress', 'in_review'] as const).map((c) => (
          <label key={c}>{WORK_ITEM_STATUS[c]}<input type="number" min={1} max={99} value={limits[c] ?? ''} onChange={(e) => setLimits({ ...limits, [c]: e.target.value })} /></label>
        ))}
      </fieldset>
    </FormModal>
  );
}
