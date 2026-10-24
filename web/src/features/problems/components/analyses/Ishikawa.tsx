import { type EditorProps, replaceAt } from './common';
import '../../styles.css';

export function Ishikawa({ data, set, readOnly }: EditorProps) {
  const categories: { name: string; causes: string[]; considered?: boolean }[] = data.categories ?? [];
  return (
    <div className="ishikawa">
      <label>Effect (the problem)
        <input value={data.effect ?? ''} readOnly={readOnly} onChange={(e) => set({ ...data, effect: e.target.value })} placeholder="E.g. Orders time out at peak" />
      </label>
      <Fishbone effect={data.effect ?? ''} categories={categories} />
      <div className="ishikawa-grid">
        {categories.map((c, i) => (
          <label key={i}>
            {readOnly ? c.name : (
              <input className="category-name" value={c.name} onChange={(e) => set({ ...data, categories: replaceAt(categories, i, { ...c, name: e.target.value }) })} />
            )}
            <textarea
              rows={Math.max(3, c.causes.length + 1)}
              readOnly={readOnly}
              value={c.causes.join('\n')}
              placeholder="One cause per line"
              onChange={(e) => set({ ...data, categories: replaceAt(categories, i, { ...c, causes: e.target.value.split('\n') }) })}
            />
            {!c.causes.some((x) => x.trim()) && (
              <span className="check small"><input type="checkbox" disabled={readOnly} checked={!!c.considered} onChange={(e) => set({ ...data, categories: replaceAt(categories, i, { ...c, considered: e.target.checked }) })} /> Considered – nothing applies</span>
            )}
          </label>
        ))}
      </div>
    </div>
  );
}

/** A compact fishbone diagram: categories alternate above and below the spine. */
function Fishbone({ effect, categories }: { effect: string; categories: { name: string; causes: string[] }[] }) {
  const cats = categories.filter((c) => c.name.trim());
  const perSide = Math.max(1, Math.ceil(cats.length / 2));
  const W = 900, H = 340, spineY = H / 2, headX = 700, startX = 150;
  const step = (headX - startX) / (perSide + 0.5);
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  return (
    <svg className="fishbone" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Fishbone diagram">
      <line x1={startX} y1={spineY} x2={headX} y2={spineY} className="fb-spine" />
      <polygon points={`${headX},${spineY - 9} ${headX + 14},${spineY} ${headX},${spineY + 9}`} className="fb-arrow" />
      <foreignObject x={headX + 20} y={spineY - 45} width={W - headX - 22} height={90}>
        <div className="fb-effect">{effect || 'Effect'}</div>
      </foreignObject>
      {cats.map((c, i) => {
        const top = i % 2 === 0;
        const slot = Math.floor(i / 2);
        const x = startX + step * (slot + 1);
        const endY = top ? 34 : H - 34;
        const endX = x - 60;
        const causes = c.causes.filter((s) => s.trim()).slice(0, 5);
        return (
          <g key={i}>
            <line x1={endX} y1={endY} x2={x} y2={spineY} className="fb-bone" />
            <text x={endX} y={top ? endY - 10 : endY + 20} className="fb-cat" textAnchor="middle">{clip(c.name, 18)}</text>
            {causes.map((cause, j) => {
              const t = (j + 1) / (causes.length + 1);
              const bx = endX + (x - endX) * t;
              const by = endY + (spineY - endY) * t;
              return (
                <g key={j}>
                  <line x1={bx - 70} y1={by} x2={bx} y2={by} className="fb-cause-line" />
                  <text x={bx - 72} y={by + 4} className="fb-cause" textAnchor="end">{clip(cause, 22)}</text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
