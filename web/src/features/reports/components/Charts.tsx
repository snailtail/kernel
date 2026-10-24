// Small dependency-free SVG charts. Colors come from --series-* tokens (validated palette, light and dark).
import { useRef, useState, type ReactNode } from 'react';

interface Series {
  key: string;
  label: string;
  color: string; // CSS color, normally var(--series-n)
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function useTooltip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: React.MouseEvent | React.FocusEvent, content: ReactNode) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const target = (e.currentTarget as Element).getBoundingClientRect();
    const x = 'clientX' in e ? e.clientX - box.left : target.left + target.width / 2 - box.left;
    const y = 'clientY' in e ? e.clientY - box.top : target.top - box.top;
    setTip({ x, y, content });
  };
  const node = tip && (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.content}
    </div>
  );
  return { ref, show, hide: () => setTip(null), node };
}

const niceMax = (v: number) => {
  if (v <= 4) return Math.max(1, v);
  const pow = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / (pow / 2)) * (pow / 2);
};

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>
      ))}
    </div>
  );
}

/** Grouped vertical bars per category (e.g. per week), with a hover readout per group. */
export function GroupedBars({ data, series, xLabel, height = 220 }: { data: Record<string, any>[]; series: Series[]; xLabel: (d: any) => string; height?: number }) {
  const tip = useTooltip();
  const W = 640, H = height, pad = { l: 30, r: 8, t: 10, b: 26 };
  const max = niceMax(Math.max(0, ...data.flatMap((d) => series.map((s) => d[s.key] ?? 0))));
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const groupW = plotW / Math.max(1, data.length);
  const gap = 2;
  const barW = Math.max(3, Math.min(22, (groupW * 0.7 - gap * (series.length - 1)) / series.length));
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max].map((t) => Math.round(t));
  const labelEvery = Math.ceil(data.length / 8);
  return (
    <div className="chart" ref={tip.ref}>
      <Legend series={series} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 4} className="axis" textAnchor="end">{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const gx = pad.l + groupW * i + (groupW - (barW * series.length + gap * (series.length - 1))) / 2;
          const content = (
            <>
              <div className="tip-title">{xLabel(d)}</div>
              {series.map((s) => <div key={s.key}><i style={{ background: s.color }} /><strong>{d[s.key] ?? 0}</strong> {s.label}</div>)}
            </>
          );
          return (
            <g key={i} className="hit" tabIndex={0} onMouseMove={(e) => tip.show(e, content)} onMouseLeave={tip.hide} onFocus={(e) => tip.show(e, content)} onBlur={tip.hide}>
              <rect x={pad.l + groupW * i} y={pad.t} width={groupW} height={plotH} className="hit-area" />
              {series.map((s, j) => {
                const v = d[s.key] ?? 0;
                const h = (v / max) * plotH;
                return v > 0 ? <path key={s.key} d={roundedTop(gx + j * (barW + gap), y(v), barW, h)} fill={s.color} /> : null;
              })}
              {i % labelEvery === 0 && <text x={pad.l + groupW * i + groupW / 2} y={H - 8} className="axis" textAnchor="middle">{xLabel(d)}</text>}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="baseline" />
      </svg>
      {tip.node}
    </div>
  );
}

/** A bar path with 4px rounded top corners, anchored square to the baseline. */
function roundedTop(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/** Single-series line with a crosshair readout. */
export function LineChart({ data, valueKey, label, xLabel, color = 'var(--series-1)', height = 200 }: { data: Record<string, any>[]; valueKey: string; label: string; xLabel: (d: any) => string; color?: string; height?: number }) {
  const tip = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, pad = { l: 30, r: 12, t: 12, b: 26 };
  const max = niceMax(Math.max(0, ...data.map((d) => d[valueKey])));
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const x = (i: number) => pad.l + (data.length <= 1 ? plotW / 2 : (plotW * i) / (data.length - 1));
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d[valueKey])}`).join(' ');
  const ticks = [0, max / 2, max].map((t) => Math.round(t));
  const labelEvery = Math.ceil(data.length / 8);
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - svg.left) / svg.width) * W;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / plotW) * (data.length - 1))));
    setHover(i);
    tip.show(e, (<><div className="tip-title">{xLabel(data[i])}</div><div><i style={{ background: color }} /><strong>{data[i][valueKey]}</strong> {label}</div></>));
  };
  return (
    <div className="chart" ref={tip.ref}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 4} className="axis" textAnchor="end">{t}</text>
          </g>
        ))}
        {data.map((d, i) => i % labelEvery === 0 && <text key={i} x={x(i)} y={H - 8} className="axis" textAnchor="middle">{xLabel(d)}</text>)}
        <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} className="crosshair" />
            <circle cx={x(hover)} cy={y(data[hover][valueKey])} r={4.5} fill={color} className="ring" />
          </>
        )}
        <rect x={pad.l} y={pad.t} width={plotW} height={plotH} className="hit-area" onMouseMove={onMove} onMouseLeave={() => { setHover(null); tip.hide(); }} />
      </svg>
      {tip.node}
    </div>
  );
}

/** Horizontal bars with labels on the left and the value at the end. */
export function HBars({ rows, color = 'var(--series-1)', unit = '', empty = 'No data for the period.' }: { rows: { label: string; value: number; detail?: string; href?: string }[]; color?: string; unit?: string; empty?: string }) {
  if (!rows.length) return <p className="empty">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="hbars">
      {rows.map((r) => (
        <li key={r.label} title={r.detail ? `${r.label}: ${r.detail}` : r.label}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track"><span className="hbar-fill" style={{ width: `${(r.value / max) * 100}%`, background: color }} /></span>
          <span className="hbar-value">{r.value}{unit}</span>
        </li>
      ))}
    </ul>
  );
}
