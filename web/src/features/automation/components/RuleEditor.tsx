import { useState, type FormEvent } from 'react';
import { api } from '../../../api/client';
import { Modal } from '../../../components/Modal';
import { useSession } from '../../../session';
import { useTeams } from '../../../components/Teams';
import type { RuleKind, RuleValue, RuleCondition, RuleAction, RuleDraft, Rule } from '../../../api/types/rules';
import { KINDS, STATUSES, SOURCES, CONDITION_FIELDS, TRIGGER_FIELDS, NOTIFY_ROLES, ROLE_LABEL, DURATIONS, duration, FIELD_LABEL, OPS, typeOf, words, useLookups, Sentence } from '../vocabulary';
import { DryRunCard } from './DryRunCard';

const SETTABLE = TRIGGER_FIELDS;

const emptyDraft = (kind: RuleKind): RuleDraft => ({ name: '', kind, trigger: { type: 'created' }, conditions: [], actions: [{ type: 'assign_team', team_id: 0 }] });

export function RuleEditor({ rule, manage, webhooks, onClose, onSaved }: { rule?: Rule; manage: boolean; webhooks: { id: number; name: string }[]; onClose: () => void; onSaved: (id: number) => void }) {
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

  const options = (field: string): { value: RuleValue; label: string }[] => {
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
  const decode = (field: string, raw: string): RuleValue => {
    const o = options(field).find((x) => String(x.value) === raw);
    return o ? o.value : raw;
  };
  const setCondition = (n: number, c: RuleCondition) => set({ conditions: draft.conditions.map((x, i) => (i === n ? c : x)) });
  const newCondition = (field: string): RuleCondition => {
    const first = options(field)[0]?.value;
    return typeOf(field) === 'bool' ? { field, op: 'is', value: true } : { field, op: 'is', ...(first !== undefined ? { value: first } : {}) };
  };
  const setAction = (n: number, a: RuleAction) => set({ actions: draft.actions.map((x, i) => (i === n ? a : x)) });
  const newAction = (type: RuleAction['type']): RuleAction => {
    switch (type) {
      case 'set_field': return { type, field: SETTABLE[k][0], value: SETTABLE[k][0] === 'priority' ? 2 : null };
      case 'assign_team': return { type, team_id: teams[0]?.id ?? 0 };
      case 'add_comment': return { type, text: '' };
      case 'notify': return { type, users: [], teams: [], roles: [] };
      case 'transition': return { type, to: 'closed' };
      case 'webhook': return { type, webhook_id: webhooks[0]?.id ?? 0 };
    }
  };
  const actionTypes: { type: RuleAction['type']; label: string }[] = [
    ...(SETTABLE[k].includes('team') ? [{ type: 'assign_team' as const, label: 'assign to a team' }] : []),
    { type: 'set_field', label: 'set a field' }, { type: 'add_comment', label: 'add an internal note' }, { type: 'notify', label: 'notify' },
    ...(k === 'incident' ? [{ type: 'transition' as const, label: 'move it' }] : []),
    ...(webhooks.length ? [{ type: 'webhook' as const, label: 'send to a webhook' }] : []),
  ];

  const changeKind = (kind: RuleKind) => setDraft((d) => ({ ...emptyDraft(kind), name: d.name, actions: [kind === 'request' ? { type: 'add_comment', text: '' } : { type: 'assign_team', team_id: teams[0]?.id ?? 0 }] }));

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
            <select aria-label="Kind of record" value={k} disabled={!!rule} onChange={(e) => changeKind(e.target.value as RuleKind)}>
              {kinds.map((x) => <option key={x.kind} value={x.kind}>{x.label}</option>)}
            </select>
            <select aria-label="When" value={triggerValue} onChange={(e) => setTrigger(e.target.value)}>
              <option value="created">is created</option>
              <option value="status:">changes status</option>
              {STATUSES[k].map((s) => <option key={s} value={`status:${s}`}>moves to {words(s)}</option>)}
              {TRIGGER_FIELDS[k].map((f) => <option key={f} value={`field:${f}`}>gets a new {FIELD_LABEL[f]}</option>)}
              <option value="in_status_for">has been in a status for a while</option>
              <option value="due_in">has a follow-up action coming due</option>
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
                  <select multiple aria-label="Values" className="rule-multi" value={(c.value as RuleValue[] ?? []).map(String)} onChange={(e) => setCondition(n, { ...c, value: [...e.target.selectedOptions].map((o) => decode(c.field, o.value)) })}>
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
              <select aria-label="Action" value={a.type} onChange={(e) => setAction(n, newAction(e.target.value as RuleAction['type']))}>
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
