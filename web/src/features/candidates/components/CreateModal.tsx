import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type ProblemDetail } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { LEVEL_LABEL } from '../../../format';
import { useApi } from '../../../hooks';
import { useSession } from '../../../session';
import type { Candidate, CandidateDraft } from '../../../api/types/candidates';

export function CreateModal({ candidate: c, onClose }: { candidate: Candidate; onClose: () => void }) {
  const navigate = useNavigate();
  const { meta } = useSession();
  const { data: draft, error: draftError } = useApi<CandidateDraft>(`/api/candidates/draft?${new URLSearchParams({ key: c.key })}`);
  const [form, setForm] = useState({ title: '', description: '', impact: 2, urgency: 2, category_id: '' });
  useEffect(() => {
    if (draft) setForm((f) => ({ ...f, title: draft.title, description: draft.description }));
  }, [draft]);
  const submit = async () => {
    const p = await api.post<ProblemDetail>('/api/candidates/create', {
      key: c.key,
      problem: { ...form, category_id: form.category_id ? Number(form.category_id) : null },
    });
    navigate(`/problems/${p.ref}`);
  };
  return (
    <FormModal title="Log problem from candidate" submitLabel="Log problem" canSubmit={!!draft} onClose={onClose} onSubmit={submit}>
      <p className="hint full">
        {draft
          ? <>The {draft.records} records{draft.ci_refs.length ? ` and ${draft.ci_refs.length} CI${draft.ci_refs.length === 1 ? '' : 's'}` : ''} are linked to the new problem, logged as {draft.detection === 'reactive' ? 'reactively' : 'proactively'} identified.</>
          : 'Preparing the problem from the evidence…'}
      </p>
      <label className="full">Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
      <label className="full">Description<textarea rows={8} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label>Impact
        <select value={form.impact} onChange={(e) => setForm({ ...form, impact: Number(e.target.value) })}>{[1, 2, 3].map((l) => <option key={l} value={l}>{l} – {LEVEL_LABEL[l]}</option>)}</select>
      </label>
      <label>Urgency
        <select value={form.urgency} onChange={(e) => setForm({ ...form, urgency: Number(e.target.value) })}>{[1, 2, 3].map((l) => <option key={l} value={l}>{l} – {LEVEL_LABEL[l]}</option>)}</select>
      </label>
      <label>Category
        <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
          <option value="">–</option>
          {meta.categories.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      {draftError && <div className="error full">{draftError}</div>}
    </FormModal>
  );
}
