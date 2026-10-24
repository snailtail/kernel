import { useState } from 'react';
import { api } from '../../../api/client';
import { INCIDENT_RESOLUTION } from '../../../statuses';
import { FormModal } from '../../../components/Modal';
import { useSession } from '../../../session';
import type { Incident } from '../../../api/types/incidents';

export function ResolveModal({ incident: i, onClose, onDone }: { incident: Incident; onClose: () => void; onDone: (i: Incident) => void }) {
  const [code, setCode] = useState(i.known_errors.length ? 'workaround' : 'fixed');
  const [resolution, setResolution] = useState(i.known_errors[0]?.workaround && code === 'workaround' ? `Applied the workaround from ${i.known_errors[0].ref}.` : '');
  const { meta, user } = useSession();
  const [pirOwner, setPirOwner] = useState(String(i.major?.lead_id ?? user.id));
  const [pirDue, setPirDue] = useState(new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10));
  const open = i.children.filter((c) => c.resolve_with_parent && !['resolved', 'closed'].includes(c.status));
  return (
    <FormModal title={`Resolve ${i.ref}`} submitLabel="Resolve" onClose={onClose} onSubmit={async () => {
      const review = i.is_major ? { pir_owner_id: pirOwner ? Number(pirOwner) : null, pir_due: pirDue || null } : {};
      onDone(await api.post<Incident>(`/api/incidents/${i.ref}/transition`, { to: 'resolved', resolution_code: code, resolution, ...review }));
    }}>
      <label className="full">Resolution code<select value={code} onChange={(e) => setCode(e.target.value)}>{Object.entries(INCIDENT_RESOLUTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="full">How was service restored?<textarea rows={4} required={!['duplicate', 'cancelled'].includes(code)} value={resolution} onChange={(e) => setResolution(e.target.value)} /></label>
      {open.length > 0 && <p className="hint-box full">{open.length} related incident{open.length === 1 ? '' : 's'} ({open.map((c) => c.ref).join(', ')}) will be resolved with this resolution.</p>}
      {i.is_major && (
        <>
          <p className="muted small full">Standing down: who runs the post-incident review, and by when? It starts from the timeline and the impact.</p>
          <label>Review owner<select value={pirOwner} onChange={(e) => setPirOwner(e.target.value)}><option value="">Decide later</option>{meta.assignees.filter((a) => a.role !== 'viewer').map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
          <label>Review by<input type="date" value={pirDue} onChange={(e) => setPirDue(e.target.value)} /></label>
        </>
      )}
    </FormModal>
  );
}
