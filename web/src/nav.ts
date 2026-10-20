// The one navigation definition (#102). The sidebar, the command palette ("Go to …"), the g+key shortcuts and the
// shortcut help all read from here, so they can never disagree. Groups follow the order the practices are applied:
// respond to what happens, improve by finding and removing causes, learn and share; then the registers the work
// refers to.
import type { Meta, User } from './api';
import { canEdit, isManager } from './session';

export type Module = keyof Meta['modules'];
export type IconName = 'home' | 'events' | 'incidents' | 'status' | 'candidates' | 'problems' | 'kedb' | 'changes' | 'actions' | 'improvements' | 'knowledge' | 'review' | 'pir' | 'dashboard' | 'reports' | 'services' | 'cmdb' | 'teams' | 'people' | 'help' | 'admin';
export type BadgeKey = 'my_work' | 'events' | 'incidents' | 'kedb' | 'actions' | 'reviews';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Shown as a tooltip and in the palette. */
  hint?: string;
  module?: Module;
  /** Who sees it; default everyone. */
  show?: (user: User) => boolean;
  badge?: BadgeKey;
  /** The second key after "g". */
  key?: string;
  /** Also active on these path prefixes (e.g. a record page). */
  match?: string[];
}
export interface NavGroup { id: string; label: string; purpose?: string; items: NavItem[]; register?: boolean }

export const HOME: NavItem = { to: '/', label: 'My work', icon: 'home', badge: 'my_work', key: 'm' };

export const NAV: NavGroup[] = [
  {
    id: 'respond', label: 'Respond', purpose: 'detect and restore',
    items: [
      { to: '/events', label: 'Events', icon: 'events', hint: 'Alerts from monitoring', module: 'event', badge: 'events', key: 'e' },
      { to: '/incidents', label: 'Incidents', icon: 'incidents', hint: 'Restore service', module: 'incident', badge: 'incidents', key: 't' },
      { to: '/service-status', label: 'Service status', icon: 'status', hint: 'Tell people what is happening', module: 'cmdb' },
    ],
  },
  {
    id: 'improve', label: 'Improve', purpose: 'find causes and fix them',
    items: [
      { to: '/candidates', label: 'Problem candidates', icon: 'candidates', hint: 'Recurring incidents and alerts worth a problem', key: 'c' },
      { to: '/problems', label: 'Problems', icon: 'problems', key: 'p', match: ['/problems/'] },
      { to: '/kedb', label: 'Known errors', icon: 'kedb', hint: 'Workarounds and decisions on fixes', badge: 'kedb', key: 'k' },
      { to: '/changes', label: 'Changes', icon: 'changes', hint: 'Implement the fix', module: 'change', key: 'h' },
      { to: '/actions', label: 'Actions', icon: 'actions', hint: 'Follow-ups with an owner and a date', badge: 'actions', key: 'a' },
      { to: '/improvements', label: 'Improvements', icon: 'improvements', hint: 'Continual improvement register: ideas, quick wins and their benefit', key: 'o', match: ['/improvements/'] },
    ],
  },
  {
    id: 'learn', label: 'Learn', purpose: 'share and review',
    items: [
      { to: '/knowledge', label: 'Knowledge', icon: 'knowledge', hint: 'Articles and workarounds', module: 'knowledge', key: 'b' },
      { to: '/incident-reviews', label: 'Post-incident reviews', icon: 'pir', hint: 'Blameless look-backs on major incidents', module: 'incident', badge: 'reviews', key: 'w', match: ['/incident-reviews'] },
      { to: '/review', label: 'Problem review board', icon: 'review', hint: 'The problem review meeting', key: 'v' },
      { to: '/dashboard', label: 'Dashboard', icon: 'dashboard', key: 'd' },
      { to: '/reports', label: 'Reports', icon: 'reports', hint: 'KPIs and service reports', key: 'r' },
    ],
  },
  {
    id: 'directory', label: 'Directory', purpose: 'what the work refers to', register: true,
    items: [
      { to: '/services', label: 'Services & SLAs', icon: 'services', hint: 'Service catalogue and service levels', module: 'sla', key: 'l', match: ['/services/'] },
      { to: '/cis', label: 'Configuration items', icon: 'cmdb', hint: 'CMDB: CIs, relationships and groups', module: 'cmdb', key: 'i', match: ['/cis/'] },
      { to: '/teams', label: 'Teams', icon: 'teams', module: 'incident' },
      { to: '/people', label: 'People & organisations', icon: 'people', module: 'incident', match: ['/people/'] },
    ],
  },
];

export const FOOTER: NavItem[] = [
  { to: '/guide', label: 'How it works', icon: 'help', hint: 'The process map' },
  { to: '/admin', label: 'Administration', icon: 'admin', show: isManager, match: ['/admin/', '/api-docs'] },
];

/** Extra destinations for the palette only (no menu entry of their own). */
export const PALETTE_ONLY: NavItem[] = [
  { to: '/changes?tab=schedule', label: 'Change schedule', icon: 'changes', module: 'change' },
  { to: '/services?tab=slas', label: 'Service levels (SLAs)', icon: 'services', module: 'sla' },
  { to: '/cis/groups', label: 'CI groups', icon: 'cmdb', module: 'cmdb' },
  { to: '/notifications', label: 'Notifications', icon: 'help' },
  { to: '/settings', label: 'Settings', icon: 'admin', key: 's' },
  { to: '/api-docs', label: 'API documentation', icon: 'admin' },
];

/** "+ New": what this user may create, the most common first for their role. */
export interface NewItem { to: string; label: string; module?: Module }
export function newItems(user: User, meta: Meta, path = '/'): NewItem[] {
  if (!canEdit(user)) return [];
  const on = (m?: Module) => !m || meta.modules?.[m] !== false;
  const candidates: NewItem[] = [
    { to: '/incidents?new=1', label: 'Incident', module: 'incident' },
    { to: '/problems/new', label: 'Problem' },
    { to: '/changes?new=1', label: 'Change', module: 'change' },
    { to: '/knowledge?new=1', label: 'Article', module: 'knowledge' },
    { to: '/improvements?new=1', label: 'Improvement' },
  ];
  const all = candidates.filter((i) => on(i.module));
  // On a practice's pages, its own record comes first; elsewhere what the role logs most (managers problems, others
  // incidents).
  const here = path.startsWith('/incidents') || path.startsWith('/events') ? 'Incident'
    : path.startsWith('/changes') ? 'Change'
    : path.startsWith('/knowledge') ? 'Article'
    : path.startsWith('/improvements') ? 'Improvement'
    : /^\/(problems|kedb|candidates|actions|review)/.test(path) ? 'Problem'
    : isManager(user) ? 'Problem' : 'Incident';
  const first = all.find((i) => i.label === here) ?? all[0];
  return first ? [first, ...all.filter((i) => i !== first)] : [];
}

export const visible = (item: NavItem, user: User, meta: Meta) => (!item.module || meta.modules?.[item.module] !== false) && (!item.show || item.show(user));

/** The groups and items this user sees; a group with nothing left disappears. */
export function navFor(user: User, meta: Meta) {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => visible(i, user, meta)) })).filter((g) => g.items.length);
}

/** Keyboard triage on every list (#110); the list toolkit reads these and the shortcut help lists them. */
export const LIST_KEYS = {
  down: { key: 'j', label: 'Next row in a list' },
  up: { key: 'k', label: 'Previous row in a list' },
  select: { key: 'x', label: 'Select the row (Shift+click selects a range)' },
  assign: { key: 'a', label: 'Assign the selected rows' },
  status: { key: 's', label: 'Change the status of the selected rows' },
  open: { key: 'e', label: 'Open the row' },
} as const;

/** Every destination with a "g" shortcut, from the same definition. */
export const SHORTCUTS: Record<string, string> = Object.fromEntries(
  [HOME, ...NAV.flatMap((g) => g.items), ...FOOTER, ...PALETTE_ONLY].filter((i) => i.key).map((i) => [i.key!, i.to]),
);

export const isActive = (item: NavItem, path: string) => (item.to === '/' ? path === '/' : path === item.to.split('?')[0] || (item.match ?? []).some((m) => path.startsWith(m)));
