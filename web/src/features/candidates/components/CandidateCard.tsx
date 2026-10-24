import { Link } from 'react-router';
import { formatDate, relativeTime } from '../../../format';
import type { EvidenceRecord, CandidateSeries, Candidate } from '../../../api/types/candidates';

export function CandidateCard({ c, editable, onCreate, onLink, onDecide, onRestore }: { c: Candidate; editable: boolean; onCreate: () => void; onLink: () => void; onDecide: () => void; onRestore: () => void }) {
  const ev = c.evidence;
  return (
    <article className="card candidate">
      <header>
        <div>
          <h2>
            {c.subject.type === 'incident' && c.subject.ref
              ? <Link to={`/incidents/${c.subject.ref}`} className="mono">{c.subject.ref}</Link>
              : <>{c.subject.name} {c.ci_ref && <Link to={`/cis/${c.ci_ref}`} className="mono small">{c.ci_ref}</Link>}</>}
          </h2>
          <span className="badge neutral">{c.rule_label}</span>
          {c.source && <span className="muted small"> from {c.source}</span>}
          {c.contains_personal_data && <span className="badge" title="The report holds personal data (personal identity numbers or email addresses). It is kept, and counts for AI handling.">Personal data</span>}
        </div>
        <span className="candidate-count" title={`${c.count} records`}>{c.count}</span>
      </header>
      <p className="candidate-reason">{c.reason}.</p>
      {ev.series?.map((s) => <DailyBars key={s.label} series={s} />)}
      {c.decision && (
        <p className="hint">
          {c.decision.decision === 'snoozed' ? `Snoozed until ${formatDate(c.decision.until!)}` : 'Dismissed'} by {c.decision.by ?? 'someone'} {relativeTime(c.decision.at)}: {c.decision.reason}
        </p>
      )}
      <details className="candidate-evidence">
        <summary>
          Evidence: {ev.total_records} record{ev.total_records === 1 ? '' : 's'}
          {ev.cis.length > 0 && <>, {ev.cis.length} CI{ev.cis.length === 1 ? '' : 's'}</>}
          {c.first_at && <span className="muted"> · first {relativeTime(c.first_at)}, latest {relativeTime(c.last_at!)}</span>}
        </summary>
        {ev.cis.length > 0 && (
          <ul className="chip-list candidate-cis">
            {ev.cis.map((x) => (
              <li key={`${x.role}${x.ref}`} className={x.role === 'upstream' ? 'upstream' : ''}>
                <Link to={`/cis/${x.ref}`}>{x.name}</Link> <span className="mono small muted">{x.ref}</span>
                {x.role === 'upstream' && <span className="badge neutral">shared dependency</span>}
              </li>
            ))}
          </ul>
        )}
        <ul className="record-list">
          {ev.records.map((r) => (
            <li key={r.key}>
              <span className={`kind kind-${r.kind}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
              {r.incident_ref ? <Link to={`/incidents/${r.incident_ref}`} className="mono">{r.reference}</Link>
                : r.change_ref ? <Link to={`/changes/${r.change_ref}`} className="mono">{r.reference}</Link>
                : r.kind === 'ci' ? <Link to={`/cis/${r.reference}`} className="mono">{r.reference}</Link>
                : r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer" className="mono">{r.reference}</a>
                : <span className="mono">{r.reference}</span>}
              <span className="record-summary">{r.summary}{r.note && <span className="muted"> · {r.note}</span>}</span>
              {r.occurred_at ? <time className="muted small" title={formatDate(r.occurred_at)}>{relativeTime(r.occurred_at)}</time> : <span />}
            </li>
          ))}
          {ev.total_records > ev.records.length && <li className="muted small">and {ev.total_records - ev.records.length} more</li>}
        </ul>
        {ev.notes && <p className="candidate-notes">{ev.notes}</p>}
      </details>
      {editable && (
        <div className="actions">
          {c.decision
            ? <button className="btn" onClick={onRestore}>Restore</button>
            : <>
                <button className="btn-link spacer-right" onClick={onDecide}>Dismiss or snooze</button>
                <button className="btn" onClick={onLink}>Link to existing problem</button>
                <button className="btn primary" onClick={onCreate}>Log problem</button>
              </>}
        </div>
      )}
    </article>
  );
}

/**
 * One value per day as thin bars, oldest first. Where two windows are compared, the earlier one is muted and the
 * current one carries the accent. Each bar has its value on hover; the summary is there for screen readers.
 */
function DailyBars({ series: s }: { series: CandidateSeries }) {
  const max = Math.max(1, ...s.points.map((p) => p.value));
  const splitAt = s.split ? s.points.findIndex((p) => p.day === s.split) : -1;
  const sum = (from: number, to: number) => s.points.slice(from, to).reduce((t, p) => t + p.value, 0);
  const summary = splitAt > 0
    ? `${s.label}: ${sum(splitAt, s.points.length)} ${s.unit} in the last ${s.points.length - splitAt} days, ${sum(0, splitAt)} in the ${splitAt} days before`
    : `${s.label}: ${sum(0, s.points.length)} ${s.unit} in ${s.points.length} days, at most ${max} a day`;
  const W = 6, GAP = 2, H = 40;
  return (
    <figure className="daily-bars">
      <svg viewBox={`0 0 ${s.points.length * (W + GAP)} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary}>
        {s.points.map((p, i) => {
          const h = p.value ? Math.max(2, (p.value / max) * (H - 2)) : 0;
          return (
            <g key={p.day} className={splitAt > 0 && i < splitAt ? 'before' : 'now'}>
              <rect className="hit" x={i * (W + GAP)} y={0} width={W + GAP} height={H}><title>{`${p.day}: ${p.value} ${s.unit}`}</title></rect>
              {h > 0 && <rect className="bar" x={i * (W + GAP)} y={H - h} width={W} height={h} rx={1.5}><title>{`${p.day}: ${p.value} ${s.unit}`}</title></rect>}
            </g>
          );
        })}
        <line className="baseline" x1={0} x2={s.points.length * (W + GAP)} y1={H - 0.5} y2={H - 0.5} />
      </svg>
      <figcaption className="muted small">
        {s.label}, {s.points[0].day} – {s.points[s.points.length - 1].day}{splitAt > 0 && <> · <span className="legend-before">before</span> <span className="legend-now">last {s.points.length - splitAt} days</span></>}
      </figcaption>
    </figure>
  );
}

const KIND_LABEL: Partial<Record<EvidenceRecord['kind'], string>> = { external: 'finding', ci: 'CI', sync: 'sync' };
