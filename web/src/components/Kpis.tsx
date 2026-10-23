// The cross-practice KPIs on the dashboard (#54): each tile has its value, a trend over the last six periods, how it is
// calculated and the list behind it. Which tiles show, and in what order, is the reader's own preference.
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../hooks';
import { focusPractice } from '../nav';
import { canEdit, useSession } from '../session';
import { Modal } from './Modal';

export interface KpiTile {
  id: string;
  label: string;
  value: number | null;
  unit: 'minutes' | 'percent' | 'count';
  trend: (number | null)[];
  trend_label: string;
  lower_is_better: boolean;
  detail: string;
  basis: string;
  link: string;
}
interface Kpis { period: { unit: 'month' | 'week'; starts: string[] }; tiles: KpiTile[]; restricted_records_left_out: boolean }

const dur = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);
export const formatKpi = (v: number | null, unit: KpiTile['unit']) => (v === null ? '–' : unit === 'minutes' ? dur(v) : unit === 'percent' ? `${v} %` : String(v));

export const periodLabel = (start: string, unit: 'month' | 'week') => {
  const d = new Date(`${start}T00:00:00Z`);
  return unit === 'month' ? d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
};

/** Six bars, oldest first; the current period is still running, so it is drawn lighter. Each bar has its value. */
export function Trend({ tile, starts, unit }: { tile: Pick<KpiTile, 'label' | 'unit' | 'trend' | 'trend_label'>; starts: string[]; unit: 'month' | 'week' }) {
  const max = Math.max(1, ...tile.trend.map((v) => v ?? 0));
  const w = 16, gap = 6, h = 36;
  const label = tile.trend.map((v, i) => `${periodLabel(starts[i], unit)}: ${formatKpi(v, tile.unit)}`).join('; ');
  return (
    <svg className="kpi-trend" viewBox={`0 0 ${tile.trend.length * (w + gap) - gap} ${h}`} role="img" aria-label={`${tile.label}, ${tile.trend_label}: ${label}`} preserveAspectRatio="none">
      {tile.trend.map((v, i) => {
        const bh = v === null || v === 0 ? 0 : Math.max(3, (v / max) * (h - 2));
        const current = i === tile.trend.length - 1;
        return (
          <g key={starts[i]}>
            <title>{`${periodLabel(starts[i], unit)}${current ? ' (so far)' : ''}: ${formatKpi(v, tile.unit)}`}</title>
            {/* A wide transparent target, so the tooltip is easy to reach on short bars. */}
            <rect x={i * (w + gap) - gap / 2} y={0} width={w + gap} height={h} fill="transparent" />
            {bh > 0 ? <path className={current ? 'kpi-bar current' : 'kpi-bar'} d={`M${i * (w + gap)},${h} v${-(bh - 4)} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${bh - 4} z`} /> : <rect className="kpi-bar-empty" x={i * (w + gap)} y={h - 1} width={w} height={1} />}
          </g>
        );
      })}
    </svg>
  );
}

const PRACTICE_TILES: Record<string, string[]> = { incident: ['mttr', 'sla', 'major_open'], problem: ['problems_resolved', 'recurring'], change: ['change_success'], request: ['requests_fulfilled', 'satisfaction'] };

export function KpiSection() {
  const { user, setPreferences } = useSession();
  const [unit, setUnit] = useState<'month' | 'week'>('month');
  const [editing, setEditing] = useState(false);
  const { data, error } = useApi<Kpis>(`/api/dashboard/kpis?period=${unit}`);
  if (error) return <div className="error">{error}</div>;
  if (!data) return null;
  const chosen = user.preferences.dashboard_tiles;
  // Until the reader picks their own, their practice's tiles come first (#171).
  const focus = PRACTICE_TILES[focusPractice(user) ?? ''] ?? [];
  const tiles = chosen ? chosen.map((id) => data.tiles.find((t) => t.id === id)).filter((t): t is KpiTile => !!t) : [...data.tiles.filter((t) => focus.includes(t.id)), ...data.tiles.filter((t) => !focus.includes(t.id))];
  return (
    <section className="kpis" aria-labelledby="kpis-title">
      <div className="section-head">
        <h2 id="kpis-title">Service KPIs</h2>
        <div className="head-actions">
          <div className="tabs" role="group" aria-label="Trend per">
            <button className={unit === 'month' ? 'on' : ''} aria-pressed={unit === 'month'} onClick={() => setUnit('month')}>Months</button>
            <button className={unit === 'week' ? 'on' : ''} aria-pressed={unit === 'week'} onClick={() => setUnit('week')}>Weeks</button>
          </div>
          <button className="btn small" onClick={() => setEditing(true)}>Choose tiles</button>
        </div>
      </div>
      {data.restricted_records_left_out && <p className="muted small">🔒 Some restricted records are not included.</p>}
      {tiles.length === 0 && <p className="empty">No tiles chosen. <button className="link-btn" onClick={() => setEditing(true)}>Choose some</button>.</p>}
      <div className="kpi-grid">
        {tiles.map((t) => (
          <article className="card kpi-tile" key={t.id}>
            <h3 className="kpi-label">{t.label}</h3>
            <div className="kpi-value">{formatKpi(t.value, t.unit)}</div>
            <Trend tile={t} starts={data.period.starts} unit={data.period.unit} />
            <div className="kpi-axis muted"><span>{periodLabel(data.period.starts[0], data.period.unit)}</span><span>{t.trend_label}</span></div>
            <p className="kpi-detail">{t.detail}</p>
            <div className="kpi-foot">
              <details>
                <summary>How it is calculated</summary>
                <p>{t.basis}</p>
              </details>
              <Link to={t.link} className="small">The list →</Link>
              {canEdit(user) && <Link to={`/improvements?new=1&kpi=${t.id}`} className="small" title="Suggest an improvement that this KPI should show">Improve</Link>}
            </div>
          </article>
        ))}
      </div>
      {editing && <ChooseTiles all={data.tiles} chosen={chosen ?? data.tiles.map((t) => t.id)} onClose={() => setEditing(false)} onSave={async (ids) => { await setPreferences({ dashboard_tiles: ids }); setEditing(false); }} />}
    </section>
  );
}

function ChooseTiles({ all, chosen, onClose, onSave }: { all: KpiTile[]; chosen: string[]; onClose: () => void; onSave: (ids: string[]) => Promise<void> }) {
  // Chosen tiles first in their order, then the rest.
  const [order, setOrder] = useState(() => [...chosen.filter((id) => all.some((t) => t.id === id)), ...all.map((t) => t.id).filter((id) => !chosen.includes(id))]);
  const [on, setOn] = useState(() => new Set(chosen));
  const move = (i: number, by: number) => setOrder((o) => { const n = [...o]; [n[i], n[i + by]] = [n[i + by], n[i]]; return n; });
  const label = (id: string) => all.find((t) => t.id === id)?.label ?? id;
  return (
    <Modal title="Choose dashboard tiles" onClose={onClose}>
      <p className="muted small">Only for you. Tiles of switched-off practices are not offered.</p>
      <ul className="tile-chooser">
        {order.map((id, i) => (
          <li key={id}>
            <label className="check"><input type="checkbox" checked={on.has(id)} onChange={(e) => setOn((s) => { const n = new Set(s); if (e.target.checked) n.add(id); else n.delete(id); return n; })} /> {label(id)}</label>
            <span className="tile-move">
              <button className="btn small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${label(id)} up`}>↑</button>
              <button className="btn small" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${label(id)} down`}>↓</button>
            </span>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(order.filter((id) => on.has(id)))}>Save</button>
      </div>
    </Modal>
  );
}
