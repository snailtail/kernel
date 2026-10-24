import { Link } from 'react-router';
import { IMPROVEMENT_STATUS } from '../../../statuses';
import type { ImprovementRow } from '../../../api/types/improvements';
import { rating, quadrantOf } from '../common';
import '../styles.css';

const QUADRANTS: { id: 'quick' | 'big' | 'fill' | 'pit'; title: string; hint: string }[] = [
  { id: 'quick', title: 'Quick wins', hint: 'High value, low effort: do these first.' },
  { id: 'big', title: 'Big bets', hint: 'High value, high effort: plan them, in steps.' },
  { id: 'fill', title: 'Fill-ins', hint: 'Low value, low effort: when there is time.' },
  { id: 'pit', title: 'Money pits', hint: 'Low value, high effort: question them.' },
];

/** Value up, effort to the right; quick wins top left. */
export function Matrix({ rows }: { rows: ImprovementRow[] }) {
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
