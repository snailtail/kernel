import { Link } from 'react-router';
import { formatKpi, periodLabel, Trend } from '../../../components/Kpis';
import type { Improvement } from '../../../api/types/improvements';

/** The linked KPI tile, read-only: whether the change shows in the numbers. */
export function KpiCard({ tile }: { tile: NonNullable<Improvement['kpi_tile']> }) {
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
