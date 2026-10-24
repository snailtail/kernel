// A sprint's burndown and the team's velocity (#166): small inline SVG charts with a hover title on every day or
// sprint, a legend, and the numbers as a table for screen readers and anyone who prefers them.
import { formatDay } from '../../../format';
import type { Sprint } from '../../../api/types/development';

const W = 420, H = 170, PAD = { top: 12, right: 14, bottom: 24, left: 30 };
const ticks = (max: number) => (max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, Math.round(max / 2), max]);
const short = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function Axis({ max, y }: { max: number; y: (v: number) => number }) {
  return (
    <g className="chart-axis">
      {ticks(max).map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
          <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end">{t}</text>
        </g>
      ))}
    </g>
  );
}

/** Points left at the end of each day against the ideal line from the commitment down to nothing. */
export function Burndown({ days }: { days: NonNullable<Sprint['burndown']> }) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.left ?? 0, d.ideal)));
  const step = (W - PAD.left - PAD.right) / Math.max(days.length - 1, 1);
  const x = (i: number) => PAD.left + i * step;
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const known = days.map((d, i) => ({ ...d, i })).filter((d) => d.left !== null) as { day: string; left: number; ideal: number; i: number }[];
  const path = (pts: [number, number][]) => pts.map(([px, py], n) => `${n ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const last = known[known.length - 1];
  return (
    <figure className="chart">
      <div className="chart-legend small"><span className="key key-actual" /> Points left <span className="key key-ideal" /> Ideal</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Burndown: ${last ? `${last.left} points left on ${formatDay(last.day)}` : 'nothing yet'}`}>
        <Axis max={max} y={y} />
        <path className="chart-ideal" d={path(days.map((d, i) => [x(i), y(d.ideal)]))} />
        {known.length > 0 && <path className="chart-line" d={path(known.map((d) => [x(d.i), y(d.left)]))} />}
        {known.map((d) => <circle key={d.day} className="chart-dot" cx={x(d.i)} cy={y(d.left)} r={4} />)}
        {last && <text className="chart-label" x={x(last.i) + 8} y={y(last.left) - 6}>{last.left}</text>}
        {days.map((d, i) => (
          <g key={d.day}>
            <title>{`${formatDay(d.day)}: ${d.left === null ? 'still to come' : `${d.left} points left`} (ideal ${d.ideal})`}</title>
            <rect x={x(i) - step / 2} y={0} width={step} height={H} fill="transparent" />
          </g>
        ))}
        {[0, days.length - 1].filter((i, n, a) => a.indexOf(i) === n).map((i) => (
          <text key={i} className="chart-x" x={x(i)} y={H - 6} textAnchor={i ? 'end' : 'start'}>{short(days[i].day)}</text>
        ))}
      </svg>
      <details className="chart-table small">
        <summary>As a table</summary>
        <table><thead><tr><th>Day</th><th>Points left</th><th>Ideal</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.day}><td>{formatDay(d.day)}</td><td>{d.left ?? '–'}</td><td>{d.ideal}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

/** Committed against completed points, oldest sprint first. */
export function Velocity({ v }: { v: Sprint['velocity'] }) {
  const max = Math.max(1, ...v.sprints.flatMap((s) => [s.committed, s.completed]));
  const group = (W - PAD.left - PAD.right) / Math.max(v.sprints.length, 1);
  const bar = Math.min(22, (group - 12) / 2);
  const y = (n: number) => PAD.top + (1 - n / max) * (H - PAD.top - PAD.bottom);
  const base = y(0);
  // A bar with a rounded top, anchored to the baseline; nothing for zero.
  const rect = (bx: number, n: number, cls: string) => {
    const h = base - y(n);
    if (h <= 0) return null;
    const r = Math.min(4, h, bar / 2);
    return <path className={cls} d={`M${bx},${base} v${-(h - r)} q0,${-r} ${r},${-r} h${bar - 2 * r} q${r},0 ${r},${r} v${h - r} z`} />;
  };
  return (
    <figure className="chart">
      <div className="chart-legend small"><span className="key key-committed" /> Committed <span className="key key-actual" /> Completed{v.average !== null && <span className="muted"> · average {v.average} points</span>}</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Velocity of the last ${v.sprints.length} sprints: ${v.sprints.map((s) => `${s.name} ${s.completed} of ${s.committed}`).join('; ')}`}>
        <Axis max={max} y={y} />
        {v.sprints.map((s, i) => {
          const gx = PAD.left + i * group + (group - 2 * bar - 2) / 2;
          return (
            <g key={s.id}>
              <title>{`${s.name}: ${s.completed} of ${s.committed} committed points completed`}</title>
              <rect x={PAD.left + i * group} y={0} width={group} height={H} fill="transparent" />
              {rect(gx, s.committed, 'chart-bar-committed')}
              {rect(gx + bar + 2, s.completed, 'chart-bar')}
              <text className="chart-x" x={PAD.left + (i + 0.5) * group} y={H - 6} textAnchor="middle">{s.name.length > 12 ? `${s.name.slice(0, 11)}…` : s.name}</text>
            </g>
          );
        })}
      </svg>
      <details className="chart-table small">
        <summary>As a table</summary>
        <table><thead><tr><th>Sprint</th><th>Committed</th><th>Completed</th></tr></thead>
          <tbody>{v.sprints.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.committed}</td><td>{s.completed}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
