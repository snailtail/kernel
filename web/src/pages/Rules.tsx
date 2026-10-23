// Automation rules (#49): when / if / then, written in plain sentences with dropdowns only. Managers write and enable
// rules; analysts (and agents) propose them; everyone can see what rules exist and what they did.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { Modal } from '../components/Modal';
import { formatDate, relativeTime } from '../format';
import { useApi } from '../hooks';
import { canEdit, useSession } from '../session';
import { useTeams } from './Teams';

type Kind = 'incident' | 'problem' | 'change' | 'request';
type Trigger = { type: 'created' } | { type: 'field_changed'; field: string } | { type: 'status_changed'; to?: string } | { type: 'in_status_for'; status: string; hours: number } | { type: 'due_in'; hours: number };
type Value = string | number | boolean;
interface Condition { field: string; op: string; value?: Value | Value[] }
type Action =
  | { type: 'set_field'; field: string; value: number | null }
  | { type: 'assign_team'; team_id: number }
  | { type: 'add_comment'; text: string }
  | { type: 'notify'; users: number[]; teams: number[]; roles?: Role[] }
  | { type: 'transition'; to: string }
  | { type: 'webhook'; webhook_id: number };
type Role = 'assignee' | 'team_lead' | 'approvers' | 'owner';
interface RuleDraft { name: string; kind: Kind; trigger: Trigger; conditions: Condition[]; actions: Action[] }
interface Rule extends RuleDraft {
  id: number; enabled: boolean; proposed_by_agent: boolean; recommended: string | null; owner: string | null; created_by: string | null; tripped_at: string | null; updated_at: string;
  matched_30d?: number; failed_30d?: number; last_matched_at?: string | null;
}
interface Run { id: number; record_ref: string; event: Trigger; depth: number; status: string; detail: string; results: { type: string; ok: boolean; note?: string; error?: string }[]; created_at: string; finished_at: string | null }
interface RuleDetail extends Rule { runs: Run[]; stats_30d: { matched: number; not_matched: number; skipped: number; failed: number } }
interface RuleList { rules: Rule[]; other_rules: { kind: string; label: string; count: number; enabled: number; path: string }[]; can_manage: boolean; webhooks: { id: number; name: string }[] }
interface DryRun { days: number; checked: number; matched: number; latest: { ref: string; title: string }[]; note: string }

// The allowlists, as the server has them (rules.ts); the server checks again.
const KINDS: { kind: Kind; label: string; module?: 'incident' | 'change' | 'request' }[] = [
  { kind: 'incident', label: 'an incident', module: 'incident' }, { kind: 'problem', label: 'a problem' },
  { kind: 'change', label: 'a change', module: 'change' }, { kind: 'request', label: 'a service request', module: 'request' },
];
const STATUSES: Record<Kind, string[]> = {
  incident: ['new', 'in_progress', 'on_hold', 'resolved', 'closed'],
  problem: ['new', 'analysis', 'known_error', 'resolved', 'closed'],
  change: ['draft', 'assess', 'authorize', 'scheduled', 'implementing', 'review', 'closed', 'rejected', 'cancelled'],
  request: ['submitted', 'awaiting_approval', 'in_fulfilment', 'fulfilled', 'rejected', 'cancelled'],
};
const SOURCES: Partial<Record<Kind, string[]>> = { incident: ['user', 'event', 'api', 'mcp', 'email', 'portal'], change: ['user', 'api', 'mcp', 'pipeline'] };
const CONDITION_FIELDS: Record<Kind, string[]> = {
  incident: ['service', 'ci', 'priority', 'category', 'team', 'assignee', 'status', 'caller_vip', 'source', 'is_major', 'requester_reopened'],
  problem: ['service', 'ci', 'priority', 'category', 'team', 'assignee', 'status', 'is_major'],
  change: ['service', 'ci', 'team', 'assignee', 'status', 'source'],
  request: ['service', 'priority', 'status', 'caller_vip'],
};
const TRIGGER_FIELDS: Record<Kind, string[]> = { incident: ['priority', 'category', 'team', 'assignee'], problem: ['priority', 'category', 'team', 'assignee'], change: ['team', 'assignee'], request: ['priority'] };
const SETTABLE = TRIGGER_FIELDS;
const NOTIFY_ROLES: Record<Kind, Role[]> = { incident: ['assignee', 'team_lead'], problem: ['assignee', 'team_lead', 'owner'], change: ['assignee', 'team_lead'], request: ['approvers'] };
const ROLE_LABEL: Record<Role, string> = { assignee: 'the assignee', team_lead: "the team's leads", approvers: 'the approvers', owner: "the action's owner" };
const DURATIONS = [0.25, 0.5, 1, 2, 4, 8, 24, 48, 72, 120, 168, 336, 720];
/** 0.25 → "15 minutes", 24 → "1 day", 120 → "5 days". */
const duration = (hours: number) =>
  hours < 1 ? `${Math.round(hours * 60)} minutes` : hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
const FIELD_LABEL: Record<string, string> = { service: 'service', ci: 'CI', priority: 'priority', category: 'category', team: 'team', assignee: 'assignee', status: 'status', caller_vip: 'the caller is a VIP', source: 'source', is_major: 'it is a major incident', requester_reopened: 'the caller said it was still a problem' };
const OPS: Record<string, { op: string; label: string }[]> = {
  ref: [{ op: 'is', label: 'is' }, { op: 'is_not', label: 'is not' }, { op: 'in', label: 'is one of' }, { op: 'is_empty', label: 'is empty' }],
  priority: [{ op: 'is', label: 'is' }, { op: 'is_not', label: 'is not' }, { op: 'in', label: 'is one of' }, { op: 'lt', label: 'is more urgent than' }, { op: 'gt', label: 'is less urgent than' }],
  enum: [{ op: 'is', label: 'is' }, { op: 'is_not', label: 'is not' }, { op: 'in', label: 'is one of' }],
  bool: [{ op: 'is', label: 'is' }],
};
const NOT_LABEL: Record<string, string> = { caller_vip: 'the caller is not a VIP', is_major: 'it is not a major incident', requester_reopened: 'the caller never said it was still a problem' };
const typeOf = (field: string) => (field === 'priority' ? 'priority' : field === 'status' || field === 'source' ? 'enum' : field === 'caller_vip' || field === 'is_major' || field === 'requester_reopened' ? 'bool' : 'ref');
const words = (s: string) => s.replace(/_/g, ' ');
const RUN_STATUS: Record<string, string> = { matched: 'Ran', skipped: 'Stopped', failed: 'Failed', not_matched: 'Did not match' };

interface Lookups { team: (id: number) => string; user: (id: number) => string; category: (id: number) => string; ci: (ref: string) => string; webhook?: (id: number) => string }

function useLookups(webhooks: { id: number; name: string }[] = []): Lookups & { services: { ref: string; name: string }[]; cis: { ref: string; name: string }[] } {
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

function valueLabel(field: string, v: Value, l: Lookups) {
  if (field === 'priority') return `P${v}`;
  if (field === 'team') return l.team(v as number);
  if (field === 'assignee') return l.user(v as number);
  if (field === 'category') return l.category(v as number);
  if (field === 'service' || field === 'ci') return l.ci(String(v));
  if (field === 'caller_vip' || field === 'is_major') return v ? 'yes' : 'no';
  return words(String(v));
}

/** The rule as one plain sentence, with names. */
export function sentence(r: RuleDraft, l: Lookups) {
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

function Sentence({ rule, lookups }: { rule: RuleDraft; lookups: Lookups }) {
  const s = sentence(rule, lookups);
  return (
    <span className="rule-sentence">
      <strong>When</strong> {s.when}{s.ifs.length > 0 && <>, <strong>if</strong> {s.ifs.join(' and ')}</>}, <strong>then</strong> {s.thens.join(' and ')}.
    </span>
  );
}

function RuleState({ rule }: { rule: Rule }) {
  if (rule.enabled) return <span className="tag rule-on">On</span>;
  if (rule.tripped_at) return <span className="tag warn-tag" title={`Turned off by its safety limit ${formatDate(rule.tripped_at)}`}>Off: safety limit</span>;
  if (rule.proposed_by_agent) return <span className="tag channel">Proposed by agent</span>;
  if (rule.recommended) return <span className="tag">Recommended, off</span>;
  return <span className="tag">Off</span>;
}

export function RulesPage() {
  const { user } = useSession();
  const { data, reload } = useApi<RuleList>('/api/rules');
  const lookups = useLookups(data?.webhooks);
  const [editing, setEditing] = useState<'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async (r: Rule) => {
    try {
      await api.put(`/api/rules/${r.id}/enabled`, { enabled: true });
      setError(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const navigate = useNavigate();
  const manage = data?.can_manage ?? false;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Automation rules</h1>
          <p className="muted">Small rules that do the routine: route new work, raise a VIP's priority, add a reminder note. Each rule runs as itself, with an analyst's permissions, and everything it does shows in the record's history.</p>
        </div>
        <div className="head-actions">{canEdit(user) && <button className="btn primary" onClick={() => setEditing('new')}>{manage ? 'New rule' : 'Propose a rule'}</button>}</div>
      </header>
      {error && <div className="error">{error}</div>}
      <section className="card flush">
        {data?.rules.length === 0 ? (
          <p className="empty">No rules yet. {manage ? 'Start with one that routes new incidents on a service to the team that supports it.' : 'Propose one, and a manager reviews and enables it.'}</p>
        ) : (
          <table className="table compact rule-table">
            <thead><tr><th>Rule</th><th>What it does</th><th>State</th><th className="num">Ran (30 days)</th><th>Last ran</th></tr></thead>
            <tbody>
              {data?.rules.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/rules/${r.id}`)}>
                  <td><Link to={`/rules/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link></td>
                  <td><Sentence rule={r} lookups={lookups} /></td>
                  <td>
                    <RuleState rule={r} />
                    {manage && r.recommended && !r.enabled && <button className="btn small" onClick={(e) => { e.stopPropagation(); turnOn(r); }}>Turn on</button>}
                  </td>
                  <td className="num">{r.matched_30d ?? 0}{r.failed_30d ? <span className="error-text small"> · {r.failed_30d} failed</span> : null}</td>
                  <td className="muted small">{r.last_matched_at ? relativeTime(r.last_matched_at) : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {(data?.other_rules.length ?? 0) > 0 && (
        <section className="card">
          <h2>Other rules</h2>
          <p className="muted small">These have their own pages, because they decide something different: what monitoring alerts become, and which patterns suggest a problem.</p>
          <ul className="plain-list other-rules">
            {data!.other_rules.map((o) => (
              <li key={o.kind}><Link to={o.path}>{o.label}</Link> <span className="muted small">{o.count} rules, {o.enabled} on</span></li>
            ))}
          </ul>
        </section>
      )}
      {editing && <RuleEditor manage={manage} webhooks={data?.webhooks ?? []} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); reload(); navigate(`/rules/${id}`); }} />}
    </>
  );
}

export function RulePage() {
  const { id } = useParams();
  const { user } = useSession();
  const { data: r, error, reload } = useApi<RuleDetail>(`/api/rules/${id}`);
  const { data: list } = useApi<RuleList>('/api/rules');
  const lookups = useLookups(list?.webhooks);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const manage = list?.can_manage ?? false;
  if (error) return <div className="error">{error}</div>;
  if (!r) return <p className="muted">Loading…</p>;
  const toggle = async () => {
    try {
      await api.put(`/api/rules/${r.id}/enabled`, { enabled: !r.enabled });
      setActionError(null);
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove the rule ${r.name}? Its run log goes with it; the trail keeps what it was.`)) return;
    try {
      await api.del(`/api/rules/${r.id}`);
      navigate('/rules');
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
  const recordPath = (ref: string) => `/${({ INC: 'incidents', PRB: 'problems', CHG: 'changes', REQ: 'requests' } as Record<string, string>)[ref.slice(0, 3)] ?? 'records'}/${ref}`;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="muted small"><Link to="/rules">Automation rules</Link></p>
          <h1>{r.name} <RuleState rule={r} /></h1>
          <p className="rule-lead"><Sentence rule={r} lookups={lookups} /></p>
          <p className="muted small">
            {r.proposed_by_agent ? 'Proposed by an agent' : r.recommended && !r.created_by ? 'Recommended, built in' : `Written by ${r.created_by ?? 'someone'}`}{r.owner && ` · owner ${r.owner}`} · changed {relativeTime(r.updated_at)}
          </p>
        </div>
        {manage && (
          <div className="head-actions">
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
            <button className={`btn ${r.enabled ? '' : 'primary'}`} onClick={toggle}>{r.enabled ? 'Turn off' : r.proposed_by_agent ? 'Review and enable' : 'Enable'}</button>
          </div>
        )}
      </header>
      {actionError && <div className="error">{actionError}</div>}
      {r.tripped_at && !r.enabled && (
        <div className="banner warn">Its safety limit turned it off {relativeTime(r.tripped_at)}: it took more than 50 actions in a minute. Check what it matched below before you enable it again.</div>
      )}
      {r.proposed_by_agent && !r.enabled && manage && (
        <div className="hint-box">An agent proposed this rule. Read the sentence, try a dry run, and enable it if it does what you want. Agents can never enable rules themselves.</div>
      )}
      <div className="rule-layout">
        <section className="card">
          <h2>Latest runs</h2>
          <p className="muted small">Last 30 days: {r.stats_30d.matched} ran, {r.stats_30d.not_matched} did not match, {r.stats_30d.skipped} stopped, {r.stats_30d.failed} failed.</p>
          {r.runs.length === 0 ? <p className="empty">It has not done anything yet.</p> : (
            <table className="table compact">
              <thead><tr><th>Record</th><th>When</th><th>Result</th><th>What it did</th></tr></thead>
              <tbody>
                {r.runs.map((x) => (
                  <tr key={x.id}>
                    <td><Link to={recordPath(x.record_ref)}>{x.record_ref}</Link></td>
                    <td className="muted small"><time title={formatDate(x.finished_at ?? x.created_at)}>{relativeTime(x.finished_at ?? x.created_at)}</time></td>
                    <td><span className={`tag run-${x.status}`}>{RUN_STATUS[x.status] ?? x.status}</span>{x.depth > 0 && <span className="muted small"> after {x.depth} {x.depth === 1 ? 'rule' : 'rules'}</span>}</td>
                    <td className="small">
                      {x.detail && <div>{x.detail}</div>}
                      {x.results.map((a, n) => <div key={n} className={a.ok ? '' : 'error-text'}>{words(a.type)}: {a.ok ? (a.note ?? 'done') : a.error}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <aside>
          <DryRunCard rule={r} />
          {manage && <section className="card"><button className="btn danger" onClick={remove}>Remove rule</button></section>}
        </aside>
      </div>
      {editing && canEdit(user) && <RuleEditor manage={manage} webhooks={list?.webhooks ?? []} rule={r} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </>
  );
}

function DryRunCard({ rule }: { rule: RuleDraft & { id?: number } }) {
  const [result, setResult] = useState<DryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    try {
      setResult(await api.post<DryRun>('/api/rules/dry-run', rule.id ? { id: rule.id } : { name: rule.name || 'Draft', kind: rule.kind, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    }
  };
  return (
    <section className="card dry-run">
      <h2>Dry run</h2>
      <p className="muted small">Checks the conditions against the records updated in the last 30 days. Nothing changes.</p>
      <button type="button" className="btn" onClick={run}>Try it</button>
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="dry-run-result" role="status">
          <p><strong>It would have matched {result.matched}</strong> of {result.checked}.</p>
          {result.latest.length > 0 && <ul className="plain-list small">{result.latest.map((x) => <li key={x.ref}><span className="mono">{x.ref}</span> {x.title}</li>)}</ul>}
          <p className="muted small">{result.note}</p>
        </div>
      )}
    </section>
  );
}

const emptyDraft = (kind: Kind): RuleDraft => ({ name: '', kind, trigger: { type: 'created' }, conditions: [], actions: [{ type: 'assign_team', team_id: 0 }] });

function RuleEditor({ rule, manage, webhooks, onClose, onSaved }: { rule?: Rule; manage: boolean; webhooks: { id: number; name: string }[]; onClose: () => void; onSaved: (id: number) => void }) {
  const { meta } = useSession();
  const teams = useTeams().filter((t) => t.active);
  const lookups = useLookups(webhooks);
  const kinds = KINDS.filter((k) => !k.module || meta.modules[k.module]);
  const [draft, setDraft] = useState<RuleDraft>(rule ? { name: rule.name, kind: rule.kind, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions } : emptyDraft(kinds[0].kind));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const k = draft.kind;

  const t = draft.trigger;
  const triggerValue = t.type === 'created' ? 'created' : t.type === 'status_changed' ? `status:${t.to ?? ''}` : t.type === 'field_changed' ? `field:${t.field}` : t.type;
  const setTrigger = (v: string) => set({
    trigger: v === 'created' ? { type: 'created' }
      : v === 'in_status_for' ? { type: 'in_status_for', status: STATUSES[k][0], hours: 24 }
        : v === 'due_in' ? { type: 'due_in', hours: 24 }
          : v.startsWith('status:') ? { type: 'status_changed', ...(v.slice(7) ? { to: v.slice(7) } : {}) } : { type: 'field_changed', field: v.slice(6) },
  });

  const options = (field: string): { value: Value; label: string }[] => {
    switch (field) {
      case 'service': return lookups.services.map((s) => ({ value: s.ref, label: s.name }));
      case 'ci': return lookups.cis.map((s) => ({ value: s.ref, label: `${s.name} (${s.ref})` }));
      case 'priority': return [1, 2, 3, 4, 5].map((p) => ({ value: p, label: `P${p}` }));
      case 'category': return meta.categories.filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }));
      case 'team': return teams.map((t) => ({ value: t.id, label: t.name }));
      case 'assignee': return meta.assignees.map((u) => ({ value: u.id, label: u.display_name }));
      case 'status': return STATUSES[k].map((s) => ({ value: s, label: words(s) }));
      case 'source': return (SOURCES[k] ?? []).map((s) => ({ value: s, label: words(s) }));
      default: return [{ value: true, label: 'yes' }, { value: false, label: 'no' }];
    }
  };
  const decode = (field: string, raw: string): Value => {
    const o = options(field).find((x) => String(x.value) === raw);
    return o ? o.value : raw;
  };
  const setCondition = (n: number, c: Condition) => set({ conditions: draft.conditions.map((x, i) => (i === n ? c : x)) });
  const newCondition = (field: string): Condition => {
    const first = options(field)[0]?.value;
    return typeOf(field) === 'bool' ? { field, op: 'is', value: true } : { field, op: 'is', ...(first !== undefined ? { value: first } : {}) };
  };
  const setAction = (n: number, a: Action) => set({ actions: draft.actions.map((x, i) => (i === n ? a : x)) });
  const newAction = (type: Action['type']): Action => {
    switch (type) {
      case 'set_field': return { type, field: SETTABLE[k][0], value: SETTABLE[k][0] === 'priority' ? 2 : null };
      case 'assign_team': return { type, team_id: teams[0]?.id ?? 0 };
      case 'add_comment': return { type, text: '' };
      case 'notify': return { type, users: [], teams: [], roles: [] };
      case 'transition': return { type, to: 'closed' };
      case 'webhook': return { type, webhook_id: webhooks[0]?.id ?? 0 };
    }
  };
  const actionTypes: { type: Action['type']; label: string }[] = [
    ...(SETTABLE[k].includes('team') ? [{ type: 'assign_team' as const, label: 'assign to a team' }] : []),
    { type: 'set_field', label: 'set a field' }, { type: 'add_comment', label: 'add an internal note' }, { type: 'notify', label: 'notify' },
    ...(k === 'incident' ? [{ type: 'transition' as const, label: 'move it' }] : []),
    ...(webhooks.length ? [{ type: 'webhook' as const, label: 'send to a webhook' }] : []),
  ];

  const changeKind = (kind: Kind) => setDraft((d) => ({ ...emptyDraft(kind), name: d.name, actions: [kind === 'request' ? { type: 'add_comment', text: '' } : { type: 'assign_team', team_id: teams[0]?.id ?? 0 }] }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const saved = rule
        ? await api.put<Rule>(`/api/rules/${rule.id}`, draft)
        : await api.post<Rule>(manage ? '/api/rules' : '/api/rules/proposals', draft);
      onSaved(saved.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={rule ? `Edit ${rule.name}` : manage ? 'New rule' : 'Propose a rule'} onClose={onClose}>
      <form className="rule-editor" onSubmit={submit}>
        <label className="rule-name">Name<input required maxLength={120} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Payroll routing" /></label>

        <fieldset className="rule-part">
          <legend>When</legend>
          <div className="rule-line">
            <select aria-label="Kind of record" value={k} disabled={!!rule} onChange={(e) => changeKind(e.target.value as Kind)}>
              {kinds.map((x) => <option key={x.kind} value={x.kind}>{x.label}</option>)}
            </select>
            <select aria-label="When" value={triggerValue} onChange={(e) => setTrigger(e.target.value)}>
              <option value="created">is created</option>
              <option value="status:">changes status</option>
              {STATUSES[k].map((s) => <option key={s} value={`status:${s}`}>moves to {words(s)}</option>)}
              {TRIGGER_FIELDS[k].map((f) => <option key={f} value={`field:${f}`}>gets a new {FIELD_LABEL[f]}</option>)}
              <option value="in_status_for">has been in a status for a while</option>
              {k === 'problem' && <option value="due_in">has a follow-up action coming due</option>}
            </select>
            {t.type === 'in_status_for' && (
              <select aria-label="Status" value={t.status} onChange={(e) => set({ trigger: { ...t, status: e.target.value } })}>
                {STATUSES[k].map((s) => <option key={s} value={s}>{words(s)}</option>)}
              </select>
            )}
            {(t.type === 'in_status_for' || t.type === 'due_in') && (
              <>
                <span className="muted">{t.type === 'due_in' ? 'within' : 'for'}</span>
                <select aria-label="How long" value={t.hours} onChange={(e) => set({ trigger: { ...t, hours: Number(e.target.value) } })}>
                  {DURATIONS.filter((h) => t.type !== 'due_in' || h >= 1).map((h) => <option key={h} value={h}>{duration(h)}</option>)}
                </select>
              </>
            )}
          </div>
        </fieldset>

        <fieldset className="rule-part">
          <legend>If</legend>
          {draft.conditions.length === 0 && <p className="muted small">Always (no conditions).</p>}
          {draft.conditions.map((c, n) => {
            const type = typeOf(c.field);
            const opts = options(c.field);
            return (
              <div className="rule-line" key={n}>
                {n > 0 && <span className="muted">and</span>}
                <select aria-label="Field" value={c.field} onChange={(e) => setCondition(n, newCondition(e.target.value))}>
                  {CONDITION_FIELDS[k].map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
                </select>
                {type !== 'bool' && (
                  <select aria-label="Comparison" value={c.op} onChange={(e) => {
                    const op = e.target.value;
                    const first = Array.isArray(c.value) ? c.value[0] : c.value ?? opts[0]?.value;
                    setCondition(n, op === 'is_empty' ? { field: c.field, op } : op === 'in' ? { field: c.field, op, value: first !== undefined ? [first] : [] } : { field: c.field, op, ...(first !== undefined ? { value: first } : {}) });
                  }}>
                    {OPS[type].map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                  </select>
                )}
                {c.op === 'in' ? (
                  <select multiple aria-label="Values" className="rule-multi" value={(c.value as Value[] ?? []).map(String)} onChange={(e) => setCondition(n, { ...c, value: [...e.target.selectedOptions].map((o) => decode(c.field, o.value)) })}>
                    {opts.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
                  </select>
                ) : c.op !== 'is_empty' && (
                  <select aria-label="Value" value={String(c.value ?? '')} onChange={(e) => setCondition(n, { ...c, value: decode(c.field, e.target.value) })}>
                    {opts.length === 0 && <option value="">(none to choose from)</option>}
                    {opts.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
                  </select>
                )}
                <button type="button" className="btn-link" aria-label="Remove condition" onClick={() => set({ conditions: draft.conditions.filter((_, i) => i !== n) })}>Remove</button>
              </div>
            );
          })}
          {draft.conditions.length < 10 && <button type="button" className="btn-link" onClick={() => set({ conditions: [...draft.conditions, newCondition(CONDITION_FIELDS[k][0])] })}>+ Add a condition</button>}
        </fieldset>

        <fieldset className="rule-part">
          <legend>Then</legend>
          {draft.actions.map((a, n) => (
            <div className="rule-line" key={n}>
              {n > 0 && <span className="muted">and</span>}
              <select aria-label="Action" value={a.type} onChange={(e) => setAction(n, newAction(e.target.value as Action['type']))}>
                {actionTypes.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
              {a.type === 'assign_team' && (
                <select aria-label="Team" value={a.team_id} onChange={(e) => setAction(n, { ...a, team_id: Number(e.target.value) })}>
                  {!a.team_id && <option value={0} disabled>Choose a team</option>}
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              {a.type === 'set_field' && (
                <>
                  <select aria-label="Field to set" value={a.field} onChange={(e) => setAction(n, { ...a, field: e.target.value, value: e.target.value === 'priority' ? 2 : e.target.value === 'team' ? teams[0]?.id ?? null : null })}>
                    {SETTABLE[k].map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
                  </select>
                  <span className="muted">to</span>
                  <select aria-label="New value" value={a.value ?? ''} onChange={(e) => setAction(n, { ...a, value: e.target.value ? Number(e.target.value) : null })}>
                    {a.field !== 'priority' && a.field !== 'team' && <option value="">nobody / nothing</option>}
                    {options(a.field).map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
                  </select>
                </>
              )}
              {a.type === 'add_comment' && (
                <textarea aria-label="Note" rows={2} maxLength={2000} required value={a.text} onChange={(e) => setAction(n, { ...a, text: e.target.value })} placeholder="An internal note, the same every time, e.g. “VIP caller: call back within the hour.”" />
              )}
              {a.type === 'notify' && (
                <>
                  {NOTIFY_ROLES[k].filter((r) => r !== 'owner' || t.type === 'due_in').map((r) => (
                    <label key={r} className="check small">
                      <input type="checkbox" checked={(a.roles ?? []).includes(r)} onChange={(e) => setAction(n, { ...a, roles: e.target.checked ? [...(a.roles ?? []), r] : (a.roles ?? []).filter((x) => x !== r) })} /> {ROLE_LABEL[r]}
                    </label>
                  ))}
                  <select multiple aria-label="People to notify" className="rule-multi" value={a.users.map(String)} onChange={(e) => setAction(n, { ...a, users: [...e.target.selectedOptions].map((o) => Number(o.value)) })}>
                    {meta.assignees.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                  </select>
                  <select multiple aria-label="Teams to notify" className="rule-multi" value={a.teams.map(String)} onChange={(e) => setAction(n, { ...a, teams: [...e.target.selectedOptions].map((o) => Number(o.value)) })}>
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </>
              )}
              {a.type === 'webhook' && (
                <select aria-label="Webhook" value={a.webhook_id} onChange={(e) => setAction(n, { ...a, webhook_id: Number(e.target.value) })}>
                  {webhooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              )}
              {a.type === 'transition' && (
                <select aria-label="Move to" value={a.to} onChange={(e) => setAction(n, { ...a, to: e.target.value })}>
                  <option value="closed">close it, if it is resolved</option>
                  <option value="in_progress">take it off hold</option>
                </select>
              )}
              {draft.actions.length > 1 && <button type="button" className="btn-link" aria-label="Remove action" onClick={() => set({ actions: draft.actions.filter((_, i) => i !== n) })}>Remove</button>}
            </div>
          ))}
          {draft.actions.length < 10 && <button type="button" className="btn-link" onClick={() => set({ actions: [...draft.actions, newAction(actionTypes[0].type)] })}>+ Add an action</button>}
        </fieldset>

        <p className="rule-preview"><Sentence rule={draft} lookups={lookups} /></p>
        <DryRunCard rule={draft} />
        <p className="muted small">
          {manage
            ? rule?.enabled ? 'Changes apply to the next record change.' : 'A new rule starts off. Enable it on its page when the dry run looks right.'
            : 'Your proposal starts off. A manager reviews it and enables it.'}
          {' '}A rule runs as itself with an analyst's permissions; at most 3 rules run in a row on a record, and a rule fires once per record in 10 minutes.
        </p>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">{manage ? 'Save' : 'Propose'}</button>
        </div>
      </form>
    </Modal>
  );
}
