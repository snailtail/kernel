import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../hooks';

interface Node { id: string; label: string; purpose: string; concepts: string[]; hands_over: { to: string; when: string }[]; counts: { label: string; value: number; link: string }[];
  found_by?: { rule: string; label: string; proactive: boolean; count: number; link: string }[] }
interface Map { nodes: Node[]; supporting: { id: string; label: string; purpose: string; link: string }[] }

/** The flow event → incident → problem → known error → change → resolved, with live counts from your data. */
export function ProcessMap() {
  const { data } = useApi<Map>('/api/flow');
  const [open, setOpen] = useState<string>('problem');
  if (!data) return null;
  const node = data.nodes.find((n) => n.id === open) ?? data.nodes[0];
  const label = (id: string) => data.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <section className="card process-map" aria-label="Process map">
      <ol className="flow">
        {data.nodes.map((n, i) => {
          const headline = n.counts[0];
          return (
            <li key={n.id}>
              {i > 0 && <span className="flow-arrow" aria-hidden="true">→</span>}
              <button className={`flow-node ${open === n.id ? 'on' : ''}`} onClick={() => setOpen(n.id)} aria-expanded={open === n.id}>
                <strong>{n.label}</strong>
                {headline && <span className="flow-count">{headline.value}<span className="muted small"> {headline.label}</span></span>}
              </button>
            </li>
          );
        })}
      </ol>
      {node && (
        <div className="flow-detail">
          <div>
            <h3>{node.label}</h3>
            <p>{node.purpose}</p>
            <ul className="flow-concepts">{node.concepts.map((c) => <li key={c}>{c}</li>)}</ul>
            {node.found_by && node.found_by.length > 0 && (
              <>
                <h4>How problems are found</h4>
                {[false, true].map((proactive) => (
                  <div key={String(proactive)}>
                    <span className="muted small">{proactive ? 'Before it hurts' : 'From incidents'}</span>
                    <ul className="plain-list">
                      {node.found_by!.filter((r) => r.proactive === proactive).map((r) => (
                        <li key={r.rule}><Link to={r.link}>{r.label}</Link>{r.count > 0 && <span className="muted small"> · {r.count}</span>}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </div>
          <div>
            <h4>In your Kernel now</h4>
            <ul className="plain-list">{node.counts.map((c) => <li key={c.label}><Link to={c.link}><strong>{c.value}</strong> {c.label}</Link></li>)}</ul>
            {node.hands_over.length > 0 && (
              <>
                <h4>Hands over to</h4>
                <ul className="plain-list">{node.hands_over.map((h) => <li key={h.to + h.when}><button className="btn-link" onClick={() => setOpen(h.to)}>{label(h.to)}</button> <span className="muted small">– {h.when}</span></li>)}</ul>
              </>
            )}
          </div>
        </div>
      )}
      {data.supporting.length > 0 && (
        <p className="muted small flow-supporting">
          Underneath it all: {data.supporting.map((s, i) => <span key={s.id}>{i > 0 && ' · '}<Link to={s.link}>{s.label}</Link> – {s.purpose}</span>)}
        </p>
      )}
    </section>
  );
}

interface Tip { id: string; text: string; count: number; link: string }
const week = () => {
  const d = new Date();
  return `${d.getFullYear()}-${Math.ceil((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 604_800_000)}`;
};

/** Gentle coaching on the dashboard; each tip can be dismissed for the week. */
export function HealthTips() {
  const { data } = useApi<Tip[]>('/api/health-tips');
  const key = `kernel:tips-dismissed:${week()}`;
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '[]');
    } catch {
      return [];
    }
  });
  const tips = (data ?? []).filter((t) => !dismissed.includes(t.id));
  if (!tips.length) return null;
  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private mode: dismissed for this visit only */
    }
  };
  return (
    <section className="card health-tips">
      <h2>Worth a look this week</h2>
      <ul className="plain-list">
        {tips.map((t) => (
          <li key={t.id}>
            <Link to={t.link}><strong>{t.count}</strong> {t.text}</Link>
            <button className="btn-icon small" aria-label="Dismiss for this week" onClick={() => dismiss(t.id)}>×</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
