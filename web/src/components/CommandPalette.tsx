import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useSession } from '../session';
import { Modal } from './Modal';
import { FOOTER, HOME, LIST_KEYS, NAV, newItems, PALETTE_ONLY, SHORTCUTS as GO_KEYS, visible } from '../nav';

interface Hit { type: string; ref: string; title: string; status: string; url: string; summary?: string }
interface Item { id: string; label: string; hint?: string; go: () => void }


/** Ctrl+K / "/": jump to a record by ref, search everything, or go anywhere. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { user, meta } = useSession();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api.get<Hit[]>(`/api/search?${new URLSearchParams({ q, limit: '8' })}`).then(setHits, () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const go = (path: string) => () => { navigate(path); onClose(); };
    const out: Item[] = [];
    const ref = q.trim().toUpperCase();
    if (/^[A-Z]{2,5}\d{1,9}$/.test(ref)) out.push({ id: 'ref', label: `Open ${ref}`, hint: 'Enter', go: go(/^(CI|SVC)\d/.test(ref) ? `/cis/${ref}` : /^INC\d{6}$/.test(ref) ? `/incidents/${ref}` : /^CHG\d{6}$/.test(ref) ? `/changes/${ref}` : `/problems/${ref}`) });
    for (const h of hits) out.push({ id: `${h.type}-${h.ref}`, label: `${h.ref} ${h.title}`, hint: h.status.replace('_', ' '), go: go(new URL(h.url, location.origin).pathname) });
    const needle = q.trim().toLowerCase();
    const commands: Item[] = [
      // "+ New" in the palette: the person's own record, and the others once they type (#171).
      ...newItems(user, meta, location.pathname).slice(0, needle ? undefined : 1).map((n, i) => ({ id: `new-${n.kind}`, label: `New ${n.label.toLowerCase()}`, hint: i === 0 ? 'n' : undefined, go: go(n.to) })),
      // Every destination comes from nav.ts, like the menu and the shortcuts (#102).
      ...[HOME, ...NAV.flatMap((g) => g.items), ...FOOTER, ...PALETTE_ONLY].filter((i) => visible(i, user, meta)).map((i) => ({ id: i.to, label: `Go to ${i.label}`, hint: i.key ? `g ${i.key}` : undefined, go: go(i.to) })),
    ];
    out.push(...commands.filter((c) => !needle || c.label.toLowerCase().includes(needle)));
    return out;
  }, [hits, q, navigate, onClose, user.role, meta]);

  useEffect(() => setActive(0), [items.length]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); items[active]?.go(); }
  };

  return (
    <Modal title="Go to…" onClose={onClose}>
      <input className="palette-input" autoFocus placeholder="Type a ref (PRB000012), search, or a command…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Search" />
      <ul className="palette" role="listbox" ref={listRef}>
        {items.map((it, i) => (
          <li key={it.id} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={it.go}>
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </li>
        ))}
        {items.length === 0 && <li className="muted">Nothing found.</li>}
      </ul>
    </Modal>
  );
}

// The g-shortcuts come from nav.ts, so the help can never list one that does not exist (#102).
const LABELS = Object.fromEntries([HOME, ...NAV.flatMap((g) => g.items), ...FOOTER, ...PALETTE_ONLY].map((i) => [i.to, i.label]));
const SHORTCUTS: [string, string][] = [
  ['Ctrl+K or /', 'Search and go to…'],
  ['n', 'New record: this page\'s kind, else your default'],
  ...Object.entries(GO_KEYS).map(([k, to]) => [`g ${k}`, LABELS[to]] as [string, string]),
  ...Object.values(LIST_KEYS).map((k) => [k.key, k.label] as [string, string]),
  ['Esc', 'Clear the selection in a list'],
  ['?', 'This help'],
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, v]) => (<div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>))}
      </dl>
    </Modal>
  );
}

const GOTO = GO_KEYS;

/** Global keyboard shortcuts; ignored while typing in a field. */
export function useShortcuts(open: (what: 'palette' | 'help') => void) {
  const navigate = useNavigate();
  const session = useSession();
  const latest = useRef(session);
  latest.current = session;
  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        return open('palette');
      }
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('.modal')) return;
      if (e.key === '/') { e.preventDefault(); return open('palette'); }
      if (e.key === '?') return open('help');
      if (pendingG && Date.now() - pendingG < 1200 && GOTO[e.key]) {
        pendingG = 0;
        return navigate(GOTO[e.key]);
      }
      pendingG = e.key === 'g' ? Date.now() : 0;
      if (e.key === 'n') {
        const first = newItems(latest.current.user, latest.current.meta, location.pathname)[0];
        if (first) navigate(first.to);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, open]);
}
