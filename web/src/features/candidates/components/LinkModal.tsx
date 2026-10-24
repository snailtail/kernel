import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type ProblemDetail } from '../../../api/client';
import { FormModal } from '../../../components/Modal';
import { useApi } from '../../../hooks';
import type { Candidate } from '../../../api/types/candidates';
import '../styles.css';

export function LinkModal({ candidate: c, onClose }: { candidate: Candidate; onClose: () => void }) {
  const navigate = useNavigate();
  const [ref, setRef] = useState('');
  const q = c.subject.type === 'incident' ? '' : c.subject.name;
  const { data: open } = useApi<{ ref: string; title: string }[]>(`/api/problems?${new URLSearchParams({ q })}`);
  const submit = async () => {
    const p = await api.post<ProblemDetail>('/api/candidates/link', { ref, key: c.key });
    navigate(`/problems/${p.ref}`);
  };
  return (
    <FormModal title={`Link ${c.count} records to a problem`} submitLabel="Link records" onClose={onClose} onSubmit={submit}
      actions={<Link to="/problems" className="btn-link spacer-right">Browse problems</Link>}>
      <label className="full">Problem reference
        <input required autoFocus placeholder="PRB000123" value={ref} onChange={(e) => setRef(e.target.value)} list="candidate-problems" />
        <datalist id="candidate-problems">
          {open?.map((p) => <option key={p.ref} value={p.ref}>{p.title}</option>)}
        </datalist>
      </label>
      {open && open.length > 0 && q && (
        <div className="full suggestions">
          <span className="muted small">Open problems mentioning {q}:</span>
          {open.slice(0, 5).map((p) => (
            <button type="button" key={p.ref} className="chip-btn" onClick={() => setRef(p.ref)}>{p.ref} {p.title}</button>
          ))}
        </div>
      )}
    </FormModal>
  );
}
