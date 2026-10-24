// Choosing a start page and the record "+ New" creates first (#171): in Settings, on My work's first visit, and per
// role in Administration. An empty choice follows the default one level up.
import type { Home, Meta, NewKind } from '../api/client';
import { NEW_ITEMS, START_PAGES } from '../nav';

export interface StartChoice { home?: Home | null; default_new?: NewKind | null }

const on = (meta: Meta, m?: keyof Meta['modules']) => !m || meta.modules?.[m] !== false;

export function StartPageSelects({ value, meta, onChange, inherit, creates = true }: {
  value: StartChoice;
  meta: Meta;
  onChange: (c: StartChoice) => void;
  /** The text of the empty option, e.g. "Role default (Incidents)". */
  inherit: { home: string; default_new: string };
  /** Viewers create nothing, so they only choose a start page. */
  creates?: boolean;
}) {
  return (
    <span className="start-selects">
      <label>
        <span className="muted small">Start page</span>
        <select value={value.home ?? ''} onChange={(e) => onChange({ home: (e.target.value || null) as Home | null })}>
          <option value="">{inherit.home}</option>
          {START_PAGES.filter((p) => on(meta, p.module)).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      {creates && (
        <label>
          <span className="muted small">"+ New" creates</span>
          <select value={value.default_new ?? ''} onChange={(e) => onChange({ default_new: (e.target.value || null) as NewKind | null })}>
            <option value="">{inherit.default_new}</option>
            {NEW_ITEMS.filter((i) => on(meta, i.module)).map((i) => <option key={i.kind} value={i.kind}>{i.label}</option>)}
          </select>
        </label>
      )}
    </span>
  );
}
