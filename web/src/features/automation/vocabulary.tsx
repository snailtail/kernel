import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useApi } from '../../hooks';
import { useSession } from '../../session';
import { useTeams } from '../../components/Teams';
import type { RuleKind, RuleValue, NotifyRole, RuleDraft, RuleVocabulary } from '../../api/types/rules';
import './styles.css';

// The allowlists come from the server (GET /api/rules/vocabulary, #247); only the words for them live here.
let cache: RuleVocabulary | null = null;
/** What a rule may say, per kind, fetched once per page load. Null while it loads. */
export function useRuleVocabulary() {
  const [vocabulary, setVocabulary] = useState(cache);
  useEffect(() => {
    if (cache) return;
    api.get<RuleVocabulary>('/api/rules/vocabulary').then((v) => { cache = v; setVocabulary(v); }, () => {});
  }, []);
  return vocabulary;
}
export const KIND_LABEL: Record<RuleKind, string> = { incident: 'an incident', problem: 'a problem', change: 'a change', request: 'a service request' };
export const ROLE_LABEL: Record<NotifyRole, string> = { assignee: 'the assignee', team_lead: "the team's leads", approvers: 'the approvers', owner: "the action's owner" };
export const DURATIONS = [0.25, 0.5, 1, 2, 4, 8, 24, 48, 72, 120, 168, 336, 720];
/** 0.25 → "15 minutes", 24 → "1 day", 120 → "5 days". */
export const duration = (hours: number) =>
  hours < 1 ? `${Math.round(hours * 60)} minutes` : hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
export const FIELD_LABEL: Record<string, string> = { service: 'service', ci: 'CI', priority: 'priority', category: 'category', team: 'team', assignee: 'assignee', status: 'status', caller_vip: 'the caller is a VIP', source: 'source', is_major: 'it is a major incident', requester_reopened: 'the caller said it was still a problem' };
export const OP_LABEL: Record<string, string> = { is: 'is', is_not: 'is not', in: 'is one of', is_empty: 'is empty', lt: 'is more urgent than', gt: 'is less urgent than' };
const NOT_LABEL: Record<string, string> = { caller_vip: 'the caller is not a VIP', is_major: 'it is not a major incident', requester_reopened: 'the caller never said it was still a problem' };
export const words = (s: string) => s.replace(/_/g, ' ');

interface Lookups { isBool: (field: string) => boolean; team: (id: number) => string; user: (id: number) => string; category: (id: number) => string; ci: (ref: string) => string; webhook?: (id: number) => string }

export function useLookups(webhooks: { id: number; name: string }[] = []): Lookups & { services: { ref: string; name: string }[]; cis: { ref: string; name: string }[] } {
  const { meta } = useSession();
  const teams = useTeams();
  const vocabulary = useRuleVocabulary();
  const { data: services } = useApi<{ ref: string; name: string }[]>('/api/cis?class=service&limit=200');
  const { data: cis } = useApi<{ ref: string; name: string }[]>('/api/cis?class=ci&limit=200');
  const name = <T,>(list: T[] | null | undefined, find: (t: T) => boolean, show: (t: T) => string, fallback: string) => {
    const hit = list?.find(find);
    return hit ? show(hit) : fallback;
  };
  return {
    services: services ?? [], cis: cis ?? [],
    isBool: (field) => vocabulary?.field_types[field] === 'bool',
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
  const a = KIND_LABEL[r.kind] ?? r.kind;
  const when = r.trigger.type === 'created' ? `${a} is created`
    : r.trigger.type === 'field_changed' ? `the ${FIELD_LABEL[r.trigger.field]} of ${a} changes`
      : r.trigger.type === 'in_status_for' ? `${a} has been ${words(r.trigger.status)} for ${duration(r.trigger.hours)}`
        : r.trigger.type === 'due_in' ? `a follow-up action on ${a} is due within ${duration(r.trigger.hours)}`
          : r.trigger.to ? `${a} moves to ${words(r.trigger.to)}` : `${a} changes status`;
  const ifs = r.conditions.map((c) => {
    if (l.isBool(c.field)) return c.value ? FIELD_LABEL[c.field] : NOT_LABEL[c.field];
    const op = OP_LABEL[c.op] ?? c.op;
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
