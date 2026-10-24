import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { ROLE_LABEL } from '../format';
import { useLive } from '../hooks/useLive';
import { FOOTER, HOME, isActive, navFor, newItems, visible, type BadgeKey, type NavItem } from '../nav';
import { useSession } from '../session';
import { icons } from './Icons';
import { NotificationBell } from './Notifications';

type Counts = Partial<Record<BadgeKey, number>>;
const BADGE_TEXT: Record<BadgeKey, string> = {
  my_work: 'open items assigned to you', events: 'open alerts without an incident', incidents: "unassigned incidents in your teams' queue",
  kedb: 'known errors awaiting a decision', actions: 'overdue actions', reviews: 'overdue post-incident reviews for you or your teams',
  requests: "request tasks waiting in your teams' queue, or requests waiting for your approval",
};

/** Badge counts (#102): visibility-filtered on the server, refreshed on live changes and every minute. */
function useCounts() {
  const [counts, setCounts] = useState<Counts>({});
  const load = useCallback(() => { api.get<Counts>('/api/nav/counts').then(setCounts, () => {}); }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);
  useLive(['problem:*', 'incident:*', 'change:*'], load);
  return counts;
}

function Entry({ item, counts, path, onGo }: { item: NavItem; counts: Counts; path: string; onGo: () => void }) {
  const active = isActive(item, path);
  const n = item.badge ? counts[item.badge] ?? 0 : 0;
  return (
    <Link to={item.to} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined} title={item.hint} onClick={onGo}>
      {icons[item.icon]}
      <span className="nav-label">{item.label}</span>
      {n > 0 && <span className="nav-badge" aria-label={`${n} ${BADGE_TEXT[item.badge!]}`}>{n > 99 ? '99+' : n}</span>}
    </Link>
  );
}

/** "+ New": the most common record for the role, with the others behind the arrow. */
function NewButton() {
  const { user, meta } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const items = newItems(user, meta, location.pathname);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="new-split" ref={ref}>
      <button type="button" className="btn primary new-main" onClick={() => navigate(items[0].to)}>{icons.plus}New {items[0].label.toLowerCase()}</button>
      {items.length > 1 && (
        <button type="button" className="btn primary new-more" aria-label="Create something else" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>▾</button>
      )}
      {open && (
        <ul className="new-menu" role="menu">
          {items.map((i) => (
            <li key={i.to} role="none"><button type="button" role="menuitem" onClick={() => { setOpen(false); navigate(i.to); }}>{i.label}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { user, meta, logout, setPreferences } = useSession();
  const location = useLocation();
  const counts = useCounts();
  const [drawer, setDrawer] = useState(false);
  const groups = navFor(user, meta);
  const folded = new Set(user.preferences.nav_collapsed ?? ['directory']);
  const toggle = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPreferences({ nav_collapsed: [...next] }).catch(() => {});
  };
  useEffect(() => setDrawer(false), [location.pathname]);
  const go = () => setDrawer(false);
  return (
    <aside className={`sidebar${drawer ? ' drawer-open' : ''}`}>
      <div className="brand">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <div>
          <div className="brand-name">Kernel</div>
          <div className="brand-sub">IT service management</div>
        </div>
        <button type="button" className="menu-toggle" aria-label={drawer ? 'Close menu' : 'Open menu'} aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>{drawer ? '✕' : '☰'}</button>
      </div>
      <div className="sidebar-body">
        <NewButton />
        <nav aria-label="Main">
          <Entry item={HOME} counts={counts} path={location.pathname} onGo={go} />
          <button className="search-trigger" onClick={() => { go(); onSearch(); }}>{icons.search}<span>Search</span><kbd>Ctrl K</kbd></button>
          {groups.map((g) => {
            // A folded group still opens when you are on one of its pages.
            const open = !folded.has(g.id) || g.items.some((i) => isActive(i, location.pathname));
            return (
              <div key={g.id} className={`nav-group${g.register ? ' register' : ''}`}>
                <button type="button" className="nav-group-head" aria-expanded={open} onClick={() => toggle(g.id)} title={g.purpose}>
                  <span className="nav-group-text">
                    <span className="nav-group-label">{g.label}</span>
                    {g.purpose && <span className="nav-group-purpose">{g.purpose}</span>}
                  </span>
                  <span className={`nav-chevron${open ? ' open' : ''}`}>{icons.chevron}</span>
                </button>
                {open && g.items.map((i) => <Entry key={i.to} item={i} counts={counts} path={location.pathname} onGo={go} />)}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <NotificationBell />
          {FOOTER.filter((i) => visible(i, user, meta)).map((i) => <Entry key={i.to} item={i} counts={counts} path={location.pathname} onGo={go} />)}
          <Link to="/settings" className="user-chip" onClick={go}>
            <span className="avatar">{user.display_name.slice(0, 1).toUpperCase()}</span>
            <span>
              <span className="user-name">{user.display_name}</span>
              <span className="user-role">{ROLE_LABEL[user.role]}</span>
            </span>
          </Link>
          <button className="btn-link signout" onClick={logout}>{icons.signout}Sign out</button>
        </div>
      </div>
    </aside>
  );
}
