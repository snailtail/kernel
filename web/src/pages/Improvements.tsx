// The continual improvement register (#52): a list, a Kanban board by status and a value/effort matrix, and the page
// of one improvement. Lightweight on purpose: the work itself happens in the changes, problems and actions it links.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { ActionsCard } from '../components/Actions';
import { askReason, askText } from '../components/Ask';
import { StatusBadge } from '../components/Badges';
import { CommentBox } from '../components/CommentBox';
import { GuidePanel, isGuided } from '../components/Guide';
import { HistoryPanel } from '../components/History';
import { KanbanBoard } from '../components/KanbanBoard';
import { formatKpi, periodLabel, Trend } from '../components/Kpis';
import { useListToolkit } from '../components/list/ListToolkit';
import { useColumns, type ColumnKey } from '../components/list/columns';
import { Markdown } from '../components/Markdown';
import { FormModal } from '../components/Modal';
import { Presence } from '../components/Presence';
import { SavedViews } from '../components/SavedViews';
import { TransitionButtons } from '../components/TransitionButtons';
import { RecordNotFound, VisibilityPanel } from '../components/Visibility';
import { formatDate, relativeTime } from '../format';
import { useApi, useListParams, useRecord, useSearchText } from '../hooks';
import { useLive } from '../live';
import { canEdit, useSession } from '../session';
import { IMPROVEMENT_STATUS, type ImprovementStatus } from '../statuses';
import type { ImprovementRow, Improvement, LinkRow } from '../api/types/improvements';

const STATUSES = Object.keys(IMPROVEMENT_STATUS) as ImprovementStatus[];
const SOURCE: Record<string, string> = { review: 'Post-incident review', problem: 'Problem', service_review: 'Service review', idea: 'Idea' };
/** The dashboard tiles an improvement can watch (kpis.ts TILES). */
const KPI_LABEL: Record<string, string> = {
  mttr: 'Mean time to resolve', sla: 'Resolved within SLA', change_success: 'Change success rate', recurring: 'Recurring incidents',
  problems_resolved: 'Problems resolved', major_open: 'Open major incidents',
};
const TRANSITION_LABEL: Record<ImprovementStatus, string> = { idea: 'Back to idea', approved: 'Approve', in_progress: 'Start', done: 'Mark done', rejected: 'Reject' };
/** A move back is not a decision: "Back to approved" pauses work, "Reopen" picks done work up again. */
const transitionLabel = (from: ImprovementStatus, to: ImprovementStatus) => (from === 'in_progress' && to === 'approved' ? 'Back to approved' : from === 'done' && to === 'in_progress' ? 'Reopen' : TRANSITION_LABEL[to]);

const rating = (m: { value: number | null; effort: number | null }) => (m.value && m.effort ? `V${m.value} · E${m.effort}` : '–');
/** The matrix quadrants, the same split as the server's quick_wins filter: value 4–5 is high, effort 1–2 is low. */
const quadrantOf = (m: { value: number | null; effort: number | null }) =>
  !m.value || !m.effort ? null : m.value >= 4 ? (m.effort <= 2 ? 'quick' : 'big') : m.effort <= 2 ? 'fill' : 'pit';

/** The continual improvement model in four lines (guided mode, #37). */
function ModelHint() {
  const { user } = useSession();
  const { data } = useApi<{ steps: string[] }>(isGuided(user.preferences) ? '/api/improvements/model' : null);
  if (!data) return null;
  return (
    <div className="hint-box model-hint">
      <strong>The continual improvement model</strong>
      <ol>{data.steps.map((s) => <li key={s}>{s}</li>)}</ol>
    </div>
  );
}

/** Moving a card or a row: done asks for the benefit, rejecting for a reason (the same rules as the API). */
async function transitionBody(to: ImprovementStatus, current?: string | null) {
  if (to === 'done') {
    const benefit = current?.trim() ? current : await askText('Mark done', 'What did it bring?', { confirmLabel: 'Mark done', message: 'Write down the benefit, in numbers if you have them: it is what the register is for.' });
    return benefit ? { to, benefit } : null;
  }
  if (to === 'rejected') {
    const reason = await askReason('Reject the improvement', 'Say why, so the idea is not lost and can be picked up again later.', { confirmLabel: 'Reject', danger: true });
    return reason ? { to, reason } : null;
  }
  return { to };
}

/** Keys a link to the create form carries (a service report, a KPI tile); they are not list filters. */
const PREFILL = ['source', 'service', 'from', 'to', 'kpi', 'source_ref'];

export function ImprovementsPage() {
  const { user } = useSession();
  const navigate = useNavigate();
  const { params, setParams, set } = useListParams();
  const [q, setQ] = useSearchText();
  const tab = params.get('tab') ?? 'list';
  // A link from a service report or a KPI tile opens the form with what it knows (#54); those keys are not filters.
    const [creating, setCreating] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setCreating(Object.fromEntries(PREFILL.filter((k) => params.has(k)).map((k) => [k, params.get(k)!])));
    const next = new URLSearchParams(params);
    for (const k of ['new', ...PREFILL]) next.delete(k);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const query = new URLSearchParams([...params].filter(([k]) => k !== 'tab' && !PREFILL.includes(k)));
  // The board shows every status in its own column.
  if (tab === 'board' && !query.has('status')) query.set('status', 'all');
  const { data, loading, refresh, reload } = useApi<ImprovementRow[]>(params.get('new') === '1' ? null : `/api/improvements?${query}`);
  useLive(['improvement:*'], refresh);
  const empty = data?.length === 0 && ![...query.keys()].some((k) => k !== 'status' || query.get('status') !== 'all');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Improvements</h1>
          <p className="muted">The continual improvement register: ideas from reviews, problems and service reviews, rated by value and effort, and the benefit they brought.</p>
        </div>
        {tab === 'list' && <SavedViews list="improvements" />}
        {canEdit(user) && <button className="btn primary page-new" onClick={() => setCreating({})}>Suggest an improvement</button>}
      </header>
      <div className="seg-toggle tabs" role="tablist">
        {[['list', 'List'], ['board', 'Board'], ['matrix', 'Value / effort']].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => set('tab', id === 'list' ? '' : id)}>{label}</button>
        ))}
      </div>
      <div className="filters">
        <input className="search" placeholder="Search improvements…" value={q} onChange={(e) => setQ(e.target.value)} />
        {tab !== 'board' && (
          <select value={params.get('status') ?? 'open'} onChange={(e) => set('status', e.target.value === 'open' ? '' : e.target.value)} aria-label="Status">
            <option value="open">Open</option>{STATUSES.map((s) => <option key={s} value={s}>{IMPROVEMENT_STATUS[s]}</option>)}<option value="all">All</option>
          </select>
        )}
        <select value={params.get('owner') ?? ''} onChange={(e) => set('owner', e.target.value)} aria-label="Owner">
          <option value="">Anyone</option><option value="me">Mine</option><option value="none">No owner</option>
        </select>
        <label className="check"><input type="checkbox" checked={params.get('quick_wins') === 'true'} onChange={(e) => set('quick_wins', e.target.checked ? 'true' : '')} /> Quick wins</label>
      </div>
      {empty && <ModelHint />}
      {tab === 'list' && <ImprovementList rows={data} loading={loading} filter={query.toString()} onChanged={refresh} />}
      {tab === 'board' && data && <Board rows={data} editable={canEdit(user)} onChanged={reload} />}
      {tab === 'matrix' && data && <Matrix rows={data} />}
      {creating && <NewImprovement prefill={creating} onClose={() => setCreating(null)} onDone={(ref) => navigate(`/improvements/${ref}`)} />}
    </>
  );
}

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'status', label: 'Status' }, { key: 'priority', label: 'Value / effort' }, { key: 'assignee', label: 'Owner' }, { key: 'service', label: 'Service' }, { key: 'updated', label: 'Updated' },
];

function ImprovementList({ rows, loading, filter, onChanged }: { rows: ImprovementRow[] | null; loading: boolean; filter: string; onChanged: () => void }) {
  const tk = useListToolkit({ list: 'improvements', rows, idOf: (m) => m.ref, hrefOf: (m) => `/improvements/${m.ref}`, filter, onChanged });
  const cols = useColumns('improvements', COLUMNS);
  return (
    <>
      <div className="filters">{cols.picker}</div>
      {tk.scope}
      <section className={`card flush ${loading ? 'is-loading' : ''}`} {...cols.container}>
        {rows?.length === 0 ? <p className="empty">No improvements match.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{tk.selectAll && <th className="check-col">{tk.selectAll}</th>}<th>Ref</th><th>Title</th><th data-col="status">Status</th><th data-col="priority">Value / effort</th><th className="hide-sm" data-col="assignee">Owner</th><th className="hide-sm" data-col="service">Service</th><th className="hide-sm" data-col="updated">Updated</th></tr></thead>
              <tbody>
                {rows?.map((m, n) => (
                  <tr key={m.ref} {...tk.rowProps(m, n)}>
                    {tk.selectAll && <td className="check-col">{tk.select(m, n)}</td>}
                    <td className="mono nowrap"><Link to={`/improvements/${m.ref}`}>{m.ref}</Link></td>
                    <td className="title-cell"><Link to={`/improvements/${m.ref}`}>{m.title}</Link>{quadrantOf(m) === 'quick' && <span className="tag quick-win">quick win</span>}</td>
                    <td data-col="status"><StatusBadge kind="improvement" status={m.status} /></td>
                    <td className="nowrap" data-col="priority">{rating(m)}</td>
                    <td className="hide-sm" data-col="assignee">{m.owner ?? <span className="muted">–</span>}</td>
                    <td className="hide-sm small" data-col="service">{m.service_name ?? '–'}</td>
                    <td className="hide-sm small nowrap" data-col="updated">{relativeTime(m.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {tk.bar}
    </>
  );
}

/** Kanban by status. Dragging a card is a status change with the API's rules; each card also has a menu to move it. */
function Board({ rows, editable, onChanged }: { rows: ImprovementRow[]; editable: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const move = async (row: ImprovementRow, to: ImprovementStatus) => {
    const body = await transitionBody(to);
    if (!body) return;
    setError(null);
    try {
      await api.post(`/api/improvements/${row.ref}/transition`, body);
    } catch (err) {
      setError(`${row.ref}: ${(err as Error).message}`);
    }
    onChanged();
  };
  return (
    <>
      {error && <div className="error">{error}</div>}
      <KanbanBoard label="Improvements by status" columns={STATUSES.map((s) => ({ key: s, label: IMPROVEMENT_STATUS[s] }))} columnOf={(m) => m.status}
        items={rows} editable={editable} onMove={move}
        renderCard={(m) => (
          <>
            <Link to={`/improvements/${m.ref}`} className="kanban-title">{m.title}</Link>
            <div className="kanban-meta">
              <span className="mono small">{m.ref}</span>
              <span className="small">{rating(m)}</span>
              {quadrantOf(m) === 'quick' && <span className="tag quick-win">quick win</span>}
            </div>
          </>
        )}
        renderMeta={(m) => <span className="muted small">{m.owner ?? 'No owner'}{m.service_name ? ` · ${m.service_name}` : ''}</span>} />
    </>
  );
}

const QUADRANTS: { id: 'quick' | 'big' | 'fill' | 'pit'; title: string; hint: string }[] = [
  { id: 'quick', title: 'Quick wins', hint: 'High value, low effort: do these first.' },
  { id: 'big', title: 'Big bets', hint: 'High value, high effort: plan them, in steps.' },
  { id: 'fill', title: 'Fill-ins', hint: 'Low value, low effort: when there is time.' },
  { id: 'pit', title: 'Money pits', hint: 'Low value, high effort: question them.' },
];

/** Value up, effort to the right; quick wins top left. */
function Matrix({ rows }: { rows: ImprovementRow[] }) {
  const unrated = rows.filter((m) => !quadrantOf(m));
  return (
    <>
      <div className="matrix" role="group" aria-label="Value and effort">
        <div className="matrix-axis matrix-y" aria-hidden="true">Value →</div>
        <div className="matrix-grid">
          {QUADRANTS.map((q) => {
            const list = rows.filter((m) => quadrantOf(m) === q.id).sort((a, b) => b.value! - a.value! || a.effort! - b.effort!);
            return (
              <section key={q.id} className={`card matrix-cell matrix-${q.id}`} aria-label={q.title}>
                <h2>{q.title} <span className="count">{list.length}</span></h2>
                <p className="muted small">{q.hint}</p>
                <ul className="plain-list">
                  {list.map((m) => (
                    <li key={m.ref}><Link to={`/improvements/${m.ref}`}>{m.title}</Link> <span className="muted small nowrap">{rating(m)} · {IMPROVEMENT_STATUS[m.status]}</span></li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <div className="matrix-axis matrix-x" aria-hidden="true">Effort →</div>
      </div>
      {unrated.length > 0 && (
        <section className="card">
          <h2>Not rated yet <span className="count">{unrated.length}</span></h2>
          <p className="muted small">Give them a value and an effort (1–5) to place them in the matrix.</p>
          <ul className="plain-list">{unrated.map((m) => <li key={m.ref}><Link to={`/improvements/${m.ref}`} className="mono">{m.ref}</Link> {m.title}</li>)}</ul>
        </section>
      )}
    </>
  );
}

function RatingSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label>{label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not rated</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

function NewImprovement({ prefill, onClose, onDone }: { prefill: Record<string, string>; onClose: () => void; onDone: (ref: string) => void }) {
  const fromReport = prefill.source === 'service_review' && prefill.service;
  const [form, setForm] = useState({
    title: '', service: prefill.service ?? '', value: '', effort: '', kpi: prefill.kpi && KPI_LABEL[prefill.kpi] ? prefill.kpi : '',
    description: fromReport ? `From the service review of ${prefill.service}${prefill.from ? `, ${prefill.from} – ${prefill.to}` : ''}.\n\n` : '',
  });
  const submit = async () => {
    const m = await api.post<Improvement>('/api/improvements', {
      title: form.title, description: form.description,
      ...(form.service ? { service: form.service } : {}), ...(form.value ? { value: Number(form.value) } : {}), ...(form.effort ? { effort: Number(form.effort) } : {}),
      ...(form.kpi ? { kpi: form.kpi } : {}),
      ...(prefill.source ? { source: prefill.source } : {}), ...(fromReport ? { source_ref: prefill.service } : prefill.source_ref ? { source_ref: prefill.source_ref } : {}),
    });
    onDone(m.ref);
  };
  return (
    <FormModal title="Suggest an improvement" submitLabel="Suggest" intro={<ModelHint />} onClose={onClose} onSubmit={submit}>
      <label className="full">What should get better?<input required autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Alert 30 days before a certificate expires" /></label>
      <label className="full">Where we are, and where we want to be<textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label>Service <span className="muted small">(ref)</span><input value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} placeholder="SVC…" /></label>
      <label>KPI to watch
        <select value={form.kpi} onChange={(e) => setForm({ ...form, kpi: e.target.value })}><option value="">None</option>{Object.entries(KPI_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
      <RatingSelect label="Value (1–5)" value={form.value} onChange={(value) => setForm({ ...form, value })} />
      <RatingSelect label="Effort (1–5)" value={form.effort} onChange={(effort) => setForm({ ...form, effort })} />
    </FormModal>
  );
}

function EditImprovement({ m, onClose, onDone }: { m: Improvement; onClose: () => void; onDone: (m: Improvement) => void }) {
  const { meta } = useSession();
  const [form, setForm] = useState({
    title: m.title, description: m.description ?? '', benefit: m.benefit ?? '', service: m.service?.ref ?? '', owner_id: m.owner_id ? String(m.owner_id) : '',
    value: m.value ? String(m.value) : '', effort: m.effort ? String(m.effort) : '', kpi: m.kpi ?? '',
  });
  const masked = !!m.confidential_masked;
  const submit = async () => {
    onDone(await api.patch<Improvement>(`/api/improvements/${m.ref}`, {
      title: form.title, service: form.service || null, owner_id: form.owner_id ? Number(form.owner_id) : null,
      value: form.value ? Number(form.value) : null, effort: form.effort ? Number(form.effort) : null, kpi: form.kpi || null,
      // A confidential improvement's text is only sent by people who may read it.
      ...(masked ? {} : { description: form.description, ...(form.benefit !== (m.benefit ?? '') ? { benefit: form.benefit } : {}) }),
    }));
  };
  return (
    <FormModal title={`Edit ${m.ref}`} submitLabel="Save" onClose={onClose} onSubmit={submit}>
      <label className="full">Title<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
      {!masked && <label className="full">Description<textarea rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>}
      {!masked && ['in_progress', 'done'].includes(m.status) && <label className="full">Benefit<textarea rows={3} value={form.benefit} onChange={(e) => setForm({ ...form, benefit: e.target.value })} /></label>}
      <label>Owner<select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}><option value="">No owner</option>{meta.assignees.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
      <label>Service <span className="muted small">(ref)</span><input value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} /></label>
      <RatingSelect label="Value (1–5)" value={form.value} onChange={(value) => setForm({ ...form, value })} />
      <RatingSelect label="Effort (1–5)" value={form.effort} onChange={(effort) => setForm({ ...form, effort })} />
      <label className="full">KPI to watch
        <select value={form.kpi} onChange={(e) => setForm({ ...form, kpi: e.target.value })}><option value="">None</option>{Object.entries(KPI_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
    </FormModal>
  );
}

const LINK_PATH: Record<string, (ref: string, x: LinkRow) => string | null> = {
  change: (r) => `/changes/${r}`, problem: (r) => `/problems/${r}`, incident: (r) => `/incidents/${r}`, review: (r) => `/reviews/${r}`,
  action: (_r, x) => x.action_path ?? null, document: () => null,
};

function LinksCard({ m, editable, onChange }: { m: Improvement; editable: boolean; onChange: (fn: () => Promise<Improvement>) => Promise<boolean> }) {
  const [kind, setKind] = useState('change');
  const [reference, setReference] = useState('');
  const kernel = (x: LinkRow) => x.system === 'Kernel' || x.system === '';
  return (
    <section className="card">
      <h2>Carried out by <span className="count">{m.links.length}</span></h2>
      {m.links.length === 0 && <p className="placeholder">Link the changes, problems and actions that carry it out: the work happens there.</p>}
      <ul className="plain-list">
        {m.links.map((x) => {
          const to = kernel(x) ? LINK_PATH[x.kind]?.(x.reference, x) : null;
          const label = x.kind === 'action' ? `action #${x.reference}` : x.reference;
          return (
            <li key={x.id}>
              <span className="tag">{x.kind}</span>{' '}
              {to ? <Link to={to} className="mono">{label}</Link> : x.url ? <a href={x.url} target="_blank" rel="noreferrer">{label}</a> : <span className="mono">{label}</span>}
              {x.title && ` ${x.title}`} {x.status && <span className="muted small">{x.status.replace('_', ' ')}</span>}
              {x.note && <span className="muted small"> · {x.note}</span>}
              {editable && <button className="btn-link small" aria-label={`Remove link to ${label}`} onClick={() => onChange(() => api.del(`/api/improvements/${m.ref}/links/${x.id}`))}>Remove</button>}
            </li>
          );
        })}
      </ul>
      {editable && (
        <form className="rel-form small" onSubmit={async (e) => { e.preventDefault(); if (await onChange(() => api.post(`/api/improvements/${m.ref}/links`, { kind, reference: reference.trim() }))) setReference(''); }}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            <option value="change">Change</option><option value="problem">Problem</option><option value="action">Action (id)</option><option value="incident">Incident</option><option value="review">Review</option>
          </select>
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={kind === 'action' ? '12' : kind === 'change' ? 'CHG…' : kind === 'problem' ? 'PRB…' : kind === 'review' ? 'PIR…' : 'INC…'} aria-label="Reference" />
          <button className="btn small" disabled={!reference.trim()}>Link</button>
        </form>
      )}
    </section>
  );
}

/** The linked KPI tile, read-only: whether the change shows in the numbers. */
function KpiCard({ tile }: { tile: NonNullable<Improvement['kpi_tile']> }) {
  return (
    <section className="card kpi-tile">
      <h2>{tile.label}</h2>
      <div className="kpi-value">{formatKpi(tile.value, tile.unit)}</div>
      <Trend tile={tile} starts={tile.starts} unit="month" />
      <div className="kpi-axis muted"><span>{periodLabel(tile.starts[0], 'month')}</span><span>{tile.trend_label}</span></div>
      <p className="muted small">{tile.lower_is_better ? 'Lower is better.' : 'Higher is better.'} <Link to={tile.link}>The list →</Link></p>
    </section>
  );
}

export function ImprovementPage() {
  const { ref } = useParams();
  const { user } = useSession();
  const { data: m, setData, error, reload, refresh, actionError, setActionError, run } = useRecord<Improvement>(`/api/improvements/${ref}`);
  const others = useLive([m && `improvement:${m.id}`], refresh, { presence: true });
  const [editing, setEditing] = useState(false);
  if (error) return <RecordNotFound refId={ref ?? ''} error={error} onOpened={reload} />;
  if (!m) return null;
  const path = `/api/improvements/${m.ref}`;
  const editable = canEdit(user);
  const go = async (to: ImprovementStatus) => {
    const body = await transitionBody(to, m.benefit);
    if (body) await run(() => api.post(`${path}/transition`, body));
  };
  const sourcePath = m.source_ref ? (m.source === 'service_review' ? `/cis/${m.source_ref}` : LINK_PATH[{ PRB: 'problem', PIR: 'review', INC: 'incident', CHG: 'change' }[m.source_ref.slice(0, 3)] ?? 'document']?.(m.source_ref, {} as never)) : null;

  return (
    <>
      <header className="problem-head">
        <div className="crumbs"><Link to="/improvements">Improvements</Link> / <span className="mono">{m.ref}</span> <Presence people={others} /></div>
        <h1>{m.title}</h1>
        <div className="badges">
          <StatusBadge kind="improvement" status={m.status} />
          {quadrantOf(m) === 'quick' && <span className="tag quick-win">quick win</span>}
          <span className="tag">{SOURCE[m.source]}{m.source_ref && <> {sourcePath ? <Link to={sourcePath} className="mono">{m.source_ref}</Link> : <span className="mono">{m.source_ref}</span>}</>}</span>
          <span className="muted small">Suggested by {m.created_by_name ?? 'someone'} {relativeTime(m.created_at)}</span>
        </div>
        {editable && (
          <TransitionButtons buttons={[
            ...m.transitions.map((to) => ({
              label: transitionLabel(m.status, to),
              tone: to === 'rejected' ? 'danger' as const : to === m.transitions[0] && to !== 'idea' ? 'primary' as const : undefined,
              onClick: () => go(to),
            })),
            { label: 'Edit', onClick: () => setEditing(true) },
          ]} />
        )}
        {m.status === 'idea' && !m.may_decide && <p className="muted small">A manager approves or rejects it.</p>}
        {actionError && <div className="error">{actionError}</div>}
      </header>

      <div className="problem-grid">
        <div className="problem-main">
          <GuidePanel guidance={m.next_steps} />
          <section className="card"><h2>Where we are, and where we want to be</h2>{m.confidential_masked ? <p className="placeholder">Confidential.</p> : m.description ? <Markdown text={m.description} /> : <p className="placeholder">No description.</p>}</section>
          {(m.status === 'done' || m.benefit) && <section className="card"><h2>Benefit</h2>{m.benefit ? <Markdown text={m.benefit} /> : <p className="placeholder">Confidential.</p>}</section>}
          {m.status === 'rejected' && <section className="card"><h2>Why it was rejected</h2>{m.reject_reason ? <Markdown text={m.reject_reason} /> : <p className="placeholder">Confidential.</p>}{m.decided_by_name && <p className="muted small">{m.decided_by_name}, {m.decided_at && formatDate(m.decided_at)}</p>}</section>}
          <LinksCard m={m} editable={editable} onChange={run} />
          <ActionsCard parent={m.ref} actions={m.actions} editable={editable} onChanged={reload}
            placeholder="No follow-up actions. Add the steps that carry the improvement out, each with an owner and a date." />
          <section className="card">
            <h2>Notes &amp; history</h2>
            {editable && (
              <CommentBox recordRef={m.ref} placeholder="Add a note" onError={setActionError} onSubmit={(body) => run(() => api.post(`${path}/comments`, { body }))} />
            )}
            <ul className="activity">
              {m.activity.map((a) => (
                <li key={a.id}>
                  <div className="activity-head">
                    <strong>{a.user_name ?? 'System'}</strong>{' '}
                    {a.kind === 'comment' ? 'added a note' : a.kind === 'status' ? `moved it from ${IMPROVEMENT_STATUS[a.data.status?.from as ImprovementStatus] ?? '?'} to ${IMPROVEMENT_STATUS[a.data.status?.to as ImprovementStatus] ?? '?'}` : a.body}
                    {(a.channel === 'mcp' || a.channel === 'api') && <span className="tag channel">via {a.channel.toUpperCase()}</span>}
                    <time title={formatDate(a.created_at)}>{relativeTime(a.created_at)}</time>
                  </div>
                  {a.kind === 'comment' && a.body && <Markdown text={a.body} className="activity-body" />}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="problem-side">
          <section className="card">
            <h2>Details</h2>
            <dl className="kv">
              <dt>Owner</dt><dd>{m.owner ?? '–'}</dd>
              <dt>Service</dt><dd>{m.service ? <Link to={`/cis/${m.service.ref}`}>{m.service.name}</Link> : '–'}</dd>
              <dt>Value</dt><dd>{m.value ?? '–'}</dd>
              <dt>Effort</dt><dd>{m.effort ?? '–'}</dd>
              <dt>Decided</dt><dd>{m.decided_at ? `${formatDate(m.decided_at)}${m.decided_by_name ? `, ${m.decided_by_name}` : ''}` : '–'}</dd>
              <dt>Done</dt><dd>{m.done_at ? formatDate(m.done_at) : '–'}</dd>
            </dl>
          </section>
          {m.kpi_tile ? <KpiCard tile={m.kpi_tile} /> : m.kpi && <section className="card"><h2>KPI</h2><p className="muted small">{KPI_LABEL[m.kpi] ?? m.kpi}: not shown (the practice is off, or your role cannot read reports).</p></section>}
          <VisibilityPanel record={{ ...m, assignee_id: m.owner_id }} onChange={reload} />
          <HistoryPanel recordRef={m.ref} version={m} />
        </aside>
      </div>
      {editing && <EditImprovement m={m} onClose={() => setEditing(false)} onDone={(next) => { setData(next); setEditing(false); }} />}
    </>
  );
}
