// A team's backlog mirrored from Azure DevOps, GitHub or GitLab (#168): where it comes from, the last reconciliation,
// and for managers the settings. The source owns the items' own fields; Kernel adds the links to its records.
import { useState } from 'react';
import { api } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { relativeTime } from '../../../format';
import { useApi } from '../../../hooks';
import type { TeamMirror } from '../../../api/types/development';

/** "Source name = kernel value" lines, the way the settings show a mapping. */
const toLines = (map: Record<string, string>) => Object.entries(map).map(([k, v]) => `${k} = ${v}`).join('\n');
function fromLines(text: string) {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

export function MirrorCard({ teamId, onChange }: { teamId: number; onChange: () => void }) {
  const { data, reload } = useApi<TeamMirror>(`/api/teams/${teamId}/mirror`);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data || (!data.mirrored && !data.may_manage)) return null;
  const done = () => { setEditing(false); reload(); onChange(); };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card wi-mirror">
      <h2>Mirrored backlog</h2>
      {!data.mirrored && <p className="placeholder small">The backlog lives in Kernel. A team that plans in Azure DevOps, GitHub or GitLab can mirror it here, to link its items to problems, incidents and changes.</p>}
      {data.mirrored && (
        <>
          <p className="small">
            From {data.source_label} <span className="mono">{data.scope}</span>{data.area ? <>, {data.area_name} <span className="mono">{data.area}</span></> : null}: {data.items} items.
            {!data.enabled && <span className="tag">paused</span>}
          </p>
          <p className="muted small">Titles, types, statuses and sprints change there; links to Kernel records are made here{data.comment_links ? `, and noted on the item in ${data.source_label}` : ''}.</p>
          {data.last_run && (
            <p className={`small ${data.last_run.status === 'succeeded' ? 'muted' : 'warn'}`}>
              Last sync {relativeTime(data.last_run.at)}: {data.last_run.message}
            </p>
          )}
        </>
      )}
      {error && <div className="error small">{error}</div>}
      {data.may_manage && (
        <div className="row-actions">
          <button className="btn small" onClick={() => setEditing(true)}>{data.mirrored ? 'Settings' : 'Mirror a backlog'}</button>
          {data.mirrored && <button className="btn small" disabled={busy} onClick={() => act(() => api.post(`/api/teams/${teamId}/mirror/sync`, {}))}>Sync now</button>}
          {data.mirrored && (
            <button className="btn small danger" disabled={busy} onClick={() => confirm(`Stop mirroring? ${data.team}'s items stay, with their link to ${data.source_label}, and become editable in Kernel.`) && act(() => api.del(`/api/teams/${teamId}/mirror`))}>Stop</button>
          )}
        </div>
      )}
      {editing && <EditMirror m={data} onClose={() => setEditing(false)} onDone={done} />}
    </section>
  );
}

function EditMirror({ m, onClose, onDone }: { m: TeamMirror; onClose: () => void; onDone: () => void }) {
  const sources = m.sources;
  const [sourceId, setSourceId] = useState<number | ''>(m.mirrored ? m.source_id : '');
  const [scope, setScope] = useState(m.mirrored ? m.scope : '');
  const [area, setArea] = useState(m.mirrored ? m.area : '');
  const [types, setTypes] = useState(m.mirrored ? toLines(m.type_map) : '');
  const [statuses, setStatuses] = useState(m.mirrored ? toLines(m.status_map) : '');
  const [minutes, setMinutes] = useState(String(m.mirrored ? m.schedule_minutes : 60));
  const [enabled, setEnabled] = useState(m.mirrored ? m.enabled : true);
  const [comment, setComment] = useState(m.mirrored ? m.comment_links : true);
  const source = sources.find((s) => s.id === sourceId);
  const p = source ? m.platforms[source.platform] : undefined;
  const pick = (id: number) => {
    setSourceId(id);
    const s = sources.find((x) => x.id === id);
    if (s && !s.repositories.includes(scope)) setScope(s.repositories[0] ?? '');
  };
  const submit = () => api.put(`/api/teams/${m.team_id}/mirror`, {
    source_id: sourceId, scope, area, type_map: fromLines(types), status_map: fromLines(statuses), schedule_minutes: Number(minutes), enabled, comment_links: comment,
  }).then(onDone);
  return (
    <FormModal title={`Mirror ${m.team}'s backlog`} submitLabel="Save" canSubmit={!!source && !!scope} onClose={onClose} onSubmit={submit}
      intro={<p className="muted small">The source owns each item's title, type, status, sprint and points; Kernel never changes them there. The description stays in the source, a link leads to it.</p>}>
      <label>Dev source
        <select value={sourceId} onChange={(e) => pick(Number(e.target.value))} required>
          <option value="">Choose…</option>
          {sources.filter((s) => s.enabled).map((s) => <option key={s.id} value={s.id}>{s.name}{s.name === m.platforms[s.platform]?.label ? '' : ` (${m.platforms[s.platform]?.label ?? s.platform})`}</option>)}
        </select>
      </label>
      <label>{p ? p.scope_example : 'Project'}
        <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={!source}>
          {(source?.repositories ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      {!sources.some((s) => s.enabled) && <p className="muted small full">No dev source yet: a manager adds one under Admin → Dev platforms.</p>}
      {source && !source.has_token && <p className="warn small full">{source.name} has no API token: the webhook keeps items current, but reconciliation and comments need one.</p>}
      <label className="full">{p ? `${p.area_name[0].toUpperCase()}${p.area_name.slice(1)}` : 'Area'} <span className="muted small">(empty for all of it)</span>
        <input value={area} onChange={(e) => setArea(e.target.value)} placeholder={p?.area_name === 'label' ? 'team-shop' : 'Project\\Team'} />
      </label>
      <label>Types <span className="muted small">(adjustments, one per line)</span>
        <textarea rows={3} value={types} onChange={(e) => setTypes(e.target.value)} placeholder={p ? toLines(Object.fromEntries(Object.entries(p.default_types).slice(0, 3))) : 'Feature = epic'} />
      </label>
      <label>Statuses <span className="muted small">(adjustments, one per line)</span>
        <textarea rows={3} value={statuses} onChange={(e) => setStatuses(e.target.value)} placeholder={p ? toLines(Object.fromEntries(Object.entries(p.default_statuses).slice(0, 3))) : 'Resolved = done'} />
      </label>
      {p && <p className="muted small full">Defaults: {Object.entries(p.default_types).map(([k, v]) => `${k} → ${v}`).join(', ')}. A type set to nothing ("Issue =") is not mirrored.</p>}
      <label>Reconcile every <span className="muted small">(minutes)</span><input type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></label>
      <label className="check full"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Mirroring on</label>
      <label className="check full"><input type="checkbox" checked={comment} onChange={(e) => setComment(e.target.checked)} /> Comment on the item in the source when it is linked to a Kernel record</label>
    </FormModal>
  );
}
