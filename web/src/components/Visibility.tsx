import { useState } from 'react';
import { api } from '../api';
import { useTeams } from '../pages/Teams';
import { canEdit, useSession } from '../session';
import { askReason } from './Ask';
import { Modal } from './Modal';

interface Restricted { ref: string; restricted: boolean; restricted_teams: number[]; assignee_id: number | null; created_by?: number | null }

/** Who can see this record: everyone, or (restricted) its assignee, creator and named teams (#53). */
export function VisibilityPanel({ record: r, onChange }: { record: Restricted; onChange: () => void }) {
  const { user } = useSession();
  const teams = useTeams();
  const [editing, setEditing] = useState(false);
  const names = r.restricted_teams.map((id) => teams.find((t) => t.id === id)?.name ?? `team #${id}`);
  const viaBreakGlass = r.restricted && user.role === 'admin' && r.assignee_id !== user.id && r.created_by !== user.id
    && !teams.some((t) => t.mine && r.restricted_teams.includes(t.id));
  return (
    <>
      {viaBreakGlass && (
        <p className="warn-box breakglass-banner">🔓 You are viewing a restricted record with break-glass access. It is logged, the people on the record have been told, and access ends within an hour.</p>
      )}
      <section className={`card visibility-card ${r.restricted ? 'is-restricted' : ''}`}>
        <h2>{r.restricted ? '🔒 Restricted' : 'Visibility'}</h2>
        <p className="muted small">
          {r.restricted
            ? `Only the assignee, the creator${names.length ? ` and ${names.join(', ')}` : ''} can see this record. It is left out of others' lists, searches, reports and AI tools.`
            : 'Everyone who works in Kernel can see this record.'}
        </p>
        {canEdit(user) && <button type="button" className="btn small" onClick={() => setEditing(true)}>{r.restricted ? 'Change access' : 'Restrict'}</button>}
      </section>
      {editing && <VisibilityModal record={r} onClose={() => setEditing(false)} onDone={() => { setEditing(false); onChange(); }} />}
    </>
  );
}

function VisibilityModal({ record: r, onClose, onDone }: { record: Restricted; onClose: () => void; onDone: () => void }) {
  const teams = useTeams();
  const [restricted, setRestricted] = useState(true);
  const [chosen, setChosen] = useState<number[]>(r.restricted_teams);
  const [error, setError] = useState<string | null>(null);
  const save = async (nextRestricted: boolean) => {
    const reason = await askReason(nextRestricted ? `Restrict ${r.ref}` : `Open ${r.ref} to everyone`, nextRestricted ? 'Who needs to know, and why? People outside the chosen teams will no longer find it.' : 'Why may everyone see it now?');
    if (!reason) return;
    try {
      await api.put(`/api/records/${r.ref}/visibility`, { restricted: nextRestricted, teams: nextRestricted ? chosen : [], reason });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title={`Who can see ${r.ref}`} onClose={onClose}>
      <div className="form">
        <label className="check full"><input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} /> Restricted: only the assignee, the creator and these teams</label>
        {restricted && (
          <div className="full check-grid">
            {teams.filter((t) => t.active).map((t) => (
              <label key={t.id} className="check"><input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} /> {t.name}</label>
            ))}
            {teams.length === 0 && <span className="muted small">No teams yet; then only the assignee and the creator can see it.</span>}
          </div>
        )}
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => save(restricted)}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

/** "Not found" for a record ref; administrators can open a restricted record with break-glass (#53). */
export function RecordNotFound({ refId, error, onOpened }: { refId: string; error: string; onOpened: () => void }) {
  const { user } = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const breakGlass = async () => {
    const reason = await askReason(`Break-glass access to ${refId}`, 'If this record exists and is restricted, you can open it for one hour. The reason is audited, and the people on the record are told.', { danger: true, confirmLabel: 'Open with break-glass' });
    if (!reason) return;
    try {
      await api.post(`/api/records/${refId}/break-glass`, { reason });
      onOpened();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  return (
    <section className="card">
      <div className="error">{error}</div>
      {user.role === 'admin' && /^(PRB|INC|CHG)\d{6}$/i.test(refId) && (
        <p className="muted small">If the record is restricted, you can <button type="button" className="link-btn" onClick={breakGlass}>open it with break-glass</button>.</p>
      )}
      {message && <div className="error small">{message}</div>}
    </section>
  );
}

/** For managers: their numbers leave out restricted records they cannot see. */
export function HiddenRecordsNote() {
  const { meta } = useSession();
  if (!meta.hidden_records) return null;
  return <p className="muted small hidden-note">🔒 Some records are restricted and not included in these numbers.</p>;
}
