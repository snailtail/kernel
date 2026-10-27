import { useState, type ReactNode } from 'react';
import { type ProblemDetail } from '../../../api/client';
import { CLOSURE_LABEL, FIX_TYPE_LABEL, formatDate, LEVEL_LABEL, PRIORITY_LABEL } from '../../../format';
import { isManager, useSession } from '../../../session';

export function DetailsPanel({ problem: p, editable, onSave }: { problem: ProblemDetail; editable: boolean; onSave: (f: Record<string, unknown>, base?: Record<string, unknown>) => Promise<void> }) {
  const { user, meta } = useSession();
  const [service, setService] = useState<string | null>(null);
  const field = (label: string, content: ReactNode) => (
    <>
      <dt>{label}</dt>
      <dd>{content}</dd>
    </>
  );
  const select = (key: string, value: string | number | null, options: [string | number, string][], allowEmpty?: string) =>
    editable ? (
      <select value={value ?? ''} onChange={(e) => onSave({ [key]: e.target.value === '' ? null : typeof value === 'number' || key.endsWith('_id') || key === 'impact' || key === 'urgency' ? Number(e.target.value) : e.target.value }, { [key]: value }).catch(() => {})}>
        {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    ) : (
      options.find(([v]) => v === value)?.[1] ?? allowEmpty ?? '–'
    );

  return (
    <section className="card details">
      <h2>Details</h2>
      <dl>
        {field('Assignee', select('assignee_id', p.assignee_id, meta.assignees.map((a) => [a.id, a.display_name]), 'Unassigned'))}
        {field('Category', select('category_id', p.category_id, meta.categories.filter((c) => c.active || c.id === p.category_id).map((c) => [c.id, c.name]), '–'))}
        {field('Service / CI', editable ? (
          <input value={service ?? p.affected_service} placeholder="–" onChange={(e) => setService(e.target.value)}
            onBlur={() => { if (service !== null && service !== p.affected_service) onSave({ affected_service: service }, { affected_service: p.affected_service }).catch(() => {}); setService(null); }} />
        ) : p.affected_service || '–')}
        {field('Detection', select('detection', p.detection, [['reactive', 'Reactive (incidents)'], ['proactive', 'Proactive (events, trends)']]))}
        {field('Impact', select('impact', p.impact, [1, 2, 3].map((l) => [l, `${l} – ${LEVEL_LABEL[l]}`])))}
        {field('Urgency', select('urgency', p.urgency, [1, 2, 3].map((l) => [l, `${l} – ${LEVEL_LABEL[l]}`])))}
        {field('Priority', <strong>P{p.priority} {PRIORITY_LABEL[p.priority]}</strong>)}
        {field('Major problem', editable && isManager(user) ? (
          <label className="check"><input type="checkbox" checked={p.is_major} onChange={(e) => onSave({ is_major: e.target.checked }, { is_major: p.is_major }).catch(() => {})} /> {p.is_major ? 'Yes' : 'No'}</label>
        ) : p.is_major ? 'Yes' : 'No')}
        {p.status !== 'new' && field('Fix', select('fix_type', p.fix_type, Object.entries(FIX_TYPE_LABEL), 'Not decided'))}
        {p.closure_code && field('Closure code', CLOSURE_LABEL[p.closure_code])}
      </dl>
      <dl className="dates">
        {field('Logged', formatDate(p.created_at))}
        {p.known_error_at && field('Known error', formatDate(p.known_error_at))}
        {p.resolved_at && field('Resolved', formatDate(p.resolved_at))}
        {p.closed_at && field('Closed', formatDate(p.closed_at))}
        {field('Updated', formatDate(p.updated_at))}
      </dl>
    </section>
  );
}
