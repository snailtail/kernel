import { useState } from 'react';
import { api } from '../api';
import { useTeams } from './Teams';
import { canEdit, isManager, useSession } from '../session';
import { askReason } from './Ask';
import { FormModal, Modal } from './Modal';

interface Restricted { ref: string; restricted: boolean; restricted_teams: number[]; assignee_id: number | null; created_by?: number | null; classification?: 'normal' | 'confidential'; confidential_masked?: boolean }

/** Who can see this record: everyone, or (restricted) its assignee, creator and named teams (#53). */
export function VisibilityPanel({ record: r, onChange }: { record: Restricted; onChange: () => void }) {
  const { user } = useSession();
  const teams = useTeams();
  const [editing, setEditing] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const names = r.restricted_teams.map((id) => teams.find((t) => t.id === id)?.name ?? `team #${id}`);
  const viaBreakGlass = r.restricted && user.role === 'admin' && r.assignee_id !== user.id && r.created_by !== user.id
    && !teams.some((t) => t.mine && r.restricted_teams.includes(t.id));
  const confidential = r.classification === 'confidential';
  const setConfidential = async (next: boolean) => {
    const reason = await askReason(next ? `Mark ${r.ref} confidential` : `${r.ref} is no longer confidential`, next
      ? 'Its free text (description, comments, attachments…) will be hidden from everyone except its assignee, creator and team, unless they reveal it with a reason. The title stays visible.'
      : 'Everyone who can see the record will read its text again.');
    if (!reason) return;
    try {
      await api.put(`/api/records/${r.ref}/classification`, { classification: next ? 'confidential' : 'normal', reason });
      onChange();
    } catch (err) {
      alert((err as Error).message);
    }
  };
  const revealText = async () => {
    const reason = await askReason(`Read ${r.ref}`, 'The text is shown to you for 15 minutes. Your reason is recorded on the record, where its people can see it, and in the audit trail.', { confirmLabel: 'Show the text' });
    if (!reason) return;
    try {
      await api.post(`/api/records/${r.ref}/reveal`, { reason });
      onChange();
    } catch (err) {
      alert((err as Error).message);
    }
  };
  return (
    <>
      {r.confidential_masked && (
        <p className="warn-box confidential-banner">🔏 Confidential: the text is hidden from people not working on this record. {canEdit(user) && <button type="button" className="btn small" onClick={revealText}>Show the text…</button>}</p>
      )}
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
        {confidential && <p className="muted small">🔏 Confidential: the text is masked for people outside the record, in exports and for AI agents.</p>}
        {canEdit(user) && <button type="button" className="btn small" onClick={() => setEditing(true)}>{r.restricted ? 'Change access' : 'Restrict'}</button>}
        {canEdit(user) && !r.confidential_masked && <button type="button" className="btn-link small" onClick={() => setConfidential(!confidential)}>{confidential ? 'Not confidential' : 'Mark confidential'}</button>}
        {isManager(user) && <button type="button" className="btn-link small" onClick={() => setRedacting(true)}>Remove sensitive text…</button>}
      </section>
      {editing && <VisibilityModal record={r} onClose={() => setEditing(false)} onDone={() => { setEditing(false); onChange(); }} />}
      {redacting && <RedactModal recordRef={r.ref} onClose={() => setRedacting(false)} onDone={() => { setRedacting(false); onChange(); }} />}
    </>
  );
}

function VisibilityModal({ record: r, onClose, onDone }: { record: Restricted; onClose: () => void; onDone: () => void }) {
  const teams = useTeams();
  const [restricted, setRestricted] = useState(true);
  const [chosen, setChosen] = useState<number[]>(r.restricted_teams);
  const save = async () => {
    const reason = await askReason(restricted ? `Restrict ${r.ref}` : `Open ${r.ref} to everyone`, restricted ? 'Who needs to know, and why? People outside the chosen teams will no longer find it.' : 'Why may everyone see it now?');
    if (!reason) return;
    await api.put(`/api/records/${r.ref}/visibility`, { restricted, teams: restricted ? chosen : [], reason });
    onDone();
  };
  return (
    <FormModal title={`Who can see ${r.ref}`} submitLabel="Save" onClose={onClose} onSubmit={save}>
      <label className="check full"><input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} /> Restricted: only the assignee, the creator and these teams</label>
      {restricted && (
        <div className="full check-grid">
          {teams.filter((t) => t.active).map((t) => (
            <label key={t.id} className="check"><input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} /> {t.name}</label>
          ))}
          {teams.length === 0 && <span className="muted small">No teams yet; then only the assignee and the creator can see it.</span>}
        </div>
      )}
    </FormModal>
  );
}

/** Removes secrets or a given text from the record, its history and its text attachments (#61). */
interface RedactResult {
  removed: number;
  places: Record<string, number>;
  outside: { sent: Record<string, number>; webhooks_delivered: number; articles: { ref: string; title: string }[]; images: string[] };
  dry_run?: boolean;
}
const PLACE_LABEL: Record<string, string> = {
  problems: 'record fields', incidents: 'record fields', changes: 'record fields', problem_activity: 'comments and history', incident_activity: 'comments and history',
  change_activity: 'comments and history', actions: 'actions', problem_analyses: 'analyses', problem_links: 'links', incident_links: 'links', change_links: 'links',
  change_votes: 'votes', attachments: 'text attachments', notifications: 'in-app notifications', webhook_deliveries: 'queued and stored webhook payloads',
};

function RedactModal({ recordRef, onClose, onDone }: { recordRef: string; onClose: () => void; onDone: () => void }) {
  const [secrets, setSecrets] = useState(true);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RedactResult | null>(null);
  const [result, setResult] = useState<RedactResult | null>(null);
  const body = () => ({ secrets, ...(text.trim() ? { text: text.trim() } : {}) });
  const check = async () => {
    setError(null);
    try {
      setPreview(await api.post<RedactResult>(`/api/records/${recordRef}/redact`, { ...body(), dry_run: true }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const run = async () => {
    setError(null);
    try {
      setResult(await api.post<RedactResult>(`/api/records/${recordRef}/redact`, { ...body(), reason }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const summary = (r: RedactResult) => {
    const by: Record<string, number> = {};
    for (const [t, n] of Object.entries(r.places)) by[PLACE_LABEL[t] ?? t] = (by[PLACE_LABEL[t] ?? t] ?? 0) + n;
    return Object.entries(by).map(([label, n]) => `${n} in ${label}`).join(', ');
  };
  if (result) {
    return (
      <Modal title={`Remove sensitive text from ${recordRef}`} onClose={onDone}>
        <div className="form">
          <p className="full">{result.removed ? `Removed ${result.removed} occurrence${result.removed === 1 ? '' : 's'}: ${summary(result)}.` : 'Nothing matched; the record is unchanged.'}</p>
          <div className="actions full"><button type="button" className="btn primary" onClick={onDone}>Done</button></div>
        </div>
      </Modal>
    );
  }
  const o = preview?.outside;
  const sent = o ? Object.entries(o.sent).map(([channel, n]) => `${n} ${channel === 'email' ? 'email' : channel}${n === 1 ? '' : 's'}`) : [];
  return (
    <Modal title={`Remove sensitive text from ${recordRef}`} onClose={onClose}>
      <div className="form" data-no-scan>
        <p className="muted small full">Replaces the text with [REDACTED] in the record's fields, comments, actions, analyses, links, text attachments, notifications and stored webhook payloads. The history keeps that something changed; the removal is recorded with your reason, without the text itself. This cannot be undone.</p>
        <label className="check full"><input type="checkbox" checked={secrets} onChange={(e) => { setSecrets(e.target.checked); setPreview(null); }} /> Passwords, keys, tokens and card numbers Kernel recognises</label>
        <label className="full">Also remove this exact text <span className="muted small">(a name, an account number…; at least 4 characters)</span>
          <input value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} autoComplete="off" />
        </label>
        {preview && (
          <div className="full preview-box">
            <p><strong>{preview.removed ? `${preview.removed} occurrence${preview.removed === 1 ? '' : 's'} will be removed` : 'Nothing matches'}</strong>{preview.removed ? `: ${summary(preview)}.` : '.'}</p>
            {(sent.length > 0 || (o && o.webhooks_delivered > 0)) && (
              <p className="warn-box small">Already sent and out of Kernel's reach: {[...sent, ...(o!.webhooks_delivered ? [`${o!.webhooks_delivered} delivered webhook${o!.webhooks_delivered === 1 ? '' : 's'}`] : [])].join(', ')}. Ask the receivers to delete them if needed.</p>
            )}
            <p className="muted small">Copies in Elasticsearch (the SIEM copy holds no field values) and in backups taken before now are not changed; backups age out with their retention.</p>
            {o && o.articles.length > 0 && <p className="small">Knowledge articles copied from this record are separate records – clean them too: {o.articles.map((a) => `${a.ref} (${a.title})`).join(', ')}.</p>}
            {o && o.images.length > 0 && <p className="small">Images are not scanned. Check these yourself and remove any that show the text: {o.images.join(', ')}.</p>}
          </div>
        )}
        {preview && preview.removed > 0 && (
          <label className="full">Reason <span className="muted small">(no personal details)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        {error && <div className="error full">{error}</div>}
        <div className="actions full">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {!preview
            ? <button type="button" className="btn primary" disabled={!secrets && text.trim().length < 4} onClick={check}>Check what matches</button>
            : preview.removed > 0 && <button type="button" className="btn danger" disabled={!reason.trim()} onClick={run}>Remove {preview.removed}</button>}
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
