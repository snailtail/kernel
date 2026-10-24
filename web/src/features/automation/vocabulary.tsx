import { useApi } from '../../hooks';
import { useSession } from '../../session';
import { useTeams } from '../../components/Teams';
import type { RuleKind, RuleValue, NotifyRole, RuleDraft } from '../../api/types/rules';
import './styles.css';

// The allowlists, as the server has them (rules.ts); the server checks again.
export const KINDS: { kind: RuleKind; label: string; module?: 'incident' | 'change' | 'request' }[] = [
  { kind: 'incident', label: 'an incident', module: 'incident' }, { kind: 'problem', label: 'a problem' },
  { kind: 'change', label: 'a change', module: 'change' }, { kind: 'request', label: 'a service request', module: 'request' },
];
export const STATUSES: Record<RuleKind, string[]> = {
  incident: ['new', 'in_progress', 'on_hold', 'resolved', 'closed'],
  problem: ['new', 'analysis', 'known_error', 'resolved', 'closed'],
  change: ['draft', 'assess', 'authorize', 'scheduled', 'implementing', 'review', 'closed', 'rejected', 'cancelled'],
  request: ['submitted', 'awaiting_approval', 'in_fulfilment', 'fulfilled', 'rejected', 'cancelled'],
};
export const SOURCES: Partial<Record<RuleKind, string[]>> = { incident: ['user', 'event', 'api', 'mcp', 'email', 'portal'], change: ['user', 'api', 'mcp', 'pipeline'] };
export const CONDITION_FIELDS: Record<RuleKind, string[]> = {
  incident: ['service', 'ci', 'priority', 'category', 'team', 'assignee', 'status', 'caller_vip', 'source', 'is_major', 'requester_reopened'],
  problem: ['service', 'ci', 'priority', 'category', 'team', 'assignee', 'status', 'is_major'],
  change: ['service', 'ci', 'team', 'assignee', 'status', 'source'],
  request: ['service', 'priority', 'status', 'caller_vip'],
};
export const TRIGGER_FIELDS: Record<RuleKind, string[]> = { incident: ['priority', 'category', 'team', 'assignee'], problem: ['priority', 'category', 'team', 'assignee'], change: ['team', 'assignee'], request: ['priority'] };
export const NOTIFY_ROLES: Record<RuleKind, NotifyRole[]> = { incident: ['assignee', 'team_lead', 'owner'], problem: ['assignee', 'team_lead', 'owner'], change: ['assignee', 'team_lead', 'owner'], request: ['approvers', 'owner'] };
export const ROLE_LABEL: Record<NotifyRole, string> = { assignee: 'the assignee', team_lead: "the team's leads", approvers: 'the approvers', owner: "the action's owner" };
export const DURATIONS = [0.25, 0.5, 1, 2, 4, 8, 24, 48, 72, 120, 168, 336, 720];
/** 0.25 → "15 minutes", 24 → "1 day", 120 → "5 days". */
export const duration = (hours: number) =>
  hours < 1 ? `${Math.round(hours * 60)} minutes` : hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
export const FIELD_LABEL: Record<string, string> = { service: 'service', ci: 'CI', priority: 'priority', category: 'category', team: 'team', assignee: 'assignee', status: 'status', caller_vip: 'the caller is a VIP', source: 'source', is_major: 'it is a major incident', requester_reopened: 'the caller said it was still a problem' };
export const OPS: Record<string, { op: string; label: string }[]> = {
  ref: [{ op: 'is', label: 'is' }, { op: 'is_not', label: 'is not' }, { op: 'in', label: 'is one of' }, { op: 'is_empty', label: 'is empty' }],
  priority: [{ op: 'is', label: 'is' }, { op: 'is_not', label: 'is not' }, { op: 'in', label: 'is one of' }, { op: 'lt', label: 'is more urgent than' }, { op: 'gt', label: 'is less urgent than' }],
  enum: [{ op: 'is', label: 'is' }, { op: 'is_not', label: 'is not' }, { op: 'in', label: 'is one of' }],
  bool: [{ op: 'is', label: 'is' }],
};
const NOT_LABEL: Record<string, string> = { caller_vip: 'the caller is not a VIP', is_major: 'it is not a major incident', requester_reopened: 'the caller never said it was still a problem' };
export const typeOf = (field: string) => (field === 'priority' ? 'priority' : field === 'status' || field === 'source' ? 'enum' : field === 'caller_vip' || field === 'is_major' || field === 'requester_reopened' ? 'bool' : 'ref');
export const words = (s: string) => s.replace(/_/g, ' ');

interface Lookups { team: (id: number) => string; user: (id: number) => string; category: (id: number) => string; ci: (ref: string) => string; webhook?: (id: number) => string }

export function useLookups(webhooks: { id: number; name: string }[] = []): Lookups & { services: { ref: string; name: string }[]; cis: { ref: string; name: string }[] } {
  const { meta } = useSession();
  const teams = useTeams();
  const { data: services } = useApi<{ ref: string; name: string }[]>('/api/cis?class=service&limit=200');
  const { data: cis } = useApi<{ ref: string; name: string }[]>('/api/cis?class=ci&limit=200');
  const name = <T,>(list: T[] | null | undefined, find: (t: T) => boolean, show: (t: T) => string, fallback: string) => {
    const hit = list?.find(find);
    return hit ? show(hit) : fallback;
  };
  return {
    services: services ?? [], cis: cis ?? [],
    team: (id) => name(teams, (t) => t.id === id, (t) => t.name, `team #${id}`),
    user: (id) => name(meta.assignees, (u) => u.id === id, (u) => u.display_name, `person #${id}`),
    category: (id) => name(meta.categories, (c) => c.id === id, (c) => c.name, `category #${id}`),
    ci: (ref) => name([...(services ?? []), ...(cis ?? [])], (c) => c.ref === ref, (c) => c.name, ref),
    webhook: (id) => name(webhooks, (w) => w.id === id, (w) => w.name, `#${id}`),
  };
}

function valueLabel(field: string, v: RuleValue, l: Lookups) {
  if (field === 'priority') return `P${v}`;
  if (field === 'team') return l.team(v as number);
  if (field === 'assignee') return l.user(v as number);
  if (field === 'category') return l.category(v as number);
  if (field === 'service' || field === 'ci') return l.ci(String(v));
  if (field === 'caller_vip' || field === 'is_major') return v ? 'yes' : 'no';
  return words(String(v));
}

/** The rule as one plain sentence, with names. */
function sentence(r: RuleDraft, l: Lookups) {
  const a = KINDS.find((k) => k.kind === r.kind)?.label ?? r.kind;
  const when = r.trigger.type === 'created' ? `${a} is created`
    : r.trigger.type === 'field_changed' ? `the ${FIELD_LABEL[r.trigger.field]} of ${a} changes`
      : r.trigger.type === 'in_status_for' ? `${a} has been ${words(r.trigger.status)} for ${duration(r.trigger.hours)}`
        : r.trigger.type === 'due_in' ? `a follow-up action on ${a} is due within ${duration(r.trigger.hours)}`
          : r.trigger.to ? `${a} moves to ${words(r.trigger.to)}` : `${a} changes status`;
  const ifs = r.conditions.map((c) => {
    if (typeOf(c.field) === 'bool') return c.value ? FIELD_LABEL[c.field] : NOT_LABEL[c.field];
    const op = OPS[typeOf(c.field)].find((o) => o.op === c.op)?.label ?? c.op;
    const v = c.value === undefined ? '' : ` ${(Array.isArray(c.value) ? c.value : [c.value]).map((x) => valueLabel(c.field, x, l)).join(', ')}`;
    return `${FIELD_LABEL[c.field]} ${op}${v}`;
  });
  const thens = r.actions.map((x) => {
    switch (x.type) {
      case 'set_field': return x.value === null ? `clear the ${x.field}` : `set ${x.field} to ${valueLabel(x.field, x.value, l)}`;
      case 'assign_team': return x.team_id ? `assign to team ${l.team(x.team_id)}` : 'assign to a team (choose one)';
      case 'add_comment': return `add the note “${x.text.length > 60 ? `${x.text.slice(0, 59)}…` : x.text}”`;
      case 'notify': return `notify ${[...(x.roles ?? []).map((r) => ROLE_LABEL[r]), ...x.users.map(l.user), ...x.teams.map((t) => `team ${l.team(t)}`)].join(', ') || 'nobody'}`;
      case 'transition': return x.to === 'closed' ? 'close it' : 'take it off hold';
      case 'webhook': return `send it to the webhook ${l.webhook?.(x.webhook_id) ?? `#${x.webhook_id}`}`;
    }
  });
  return { when, ifs, thens };
}

export function Sentence({ rule, lookups }: { rule: RuleDraft; lookups: Lookups }) {
  const s = sentence(rule, lookups);
  return (
    <span className="rule-sentence">
      <strong>When</strong> {s.when}{s.ifs.length > 0 && <>, <strong>if</strong> {s.ifs.join(' and ')}</>}, <strong>then</strong> {s.thens.join(' and ')}.
    </span>
  );
}
