import { useEffect, useState, type ReactNode } from 'react';
import { api, type Activity, type Status } from '../api/client';
import { CLOSURE_LABEL, FIELD_LABEL, formatDate, relativeTime } from '../format';
import { useSession } from '../session';
import { PROBLEM_STATUS } from '../statuses';
import { Markdown } from './Markdown';
import type { AuditEntry } from '../api/types/security';

const PATH: Record<string, string> = { PRB: '/problems', INC: '/incidents', CHG: '/changes', KB: '/knowledge', PIR: '/reviews', IMP: '/improvements', REQ: '/requests', CI: '/cis', SVC: '/cis' };
/** The page of a record ref (PRB000001, CI000012…), or null for anything else. */
export function recordPath(ref: string): string | null {
  const m = /^([A-Z]{2,3})\d{3,}$/.exec(ref);
  return m && PATH[m[1]] ? `${PATH[m[1]]}/${ref}` : null;
}

const isChange = (v: unknown): v is { from: unknown; to: unknown } => !!v && typeof v === 'object' && 'from' in (v as object) && 'to' in (v as object);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A value as the trail holds it. Personal data and free text are kept as a digest only (ADR 0001), and a confidential
 * record's text is hidden from people not working on it, so those show that they changed rather than what to.
 */
export function showValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '–';
  if (isObject(v) && v.masked === true) return 'hidden (confidential)';
  if (isObject(v) && typeof v.length === 'number' && ('digest' in v || 'changed' in v)) return `changed text (${v.length} characters)`;
  if (v === '[changed]') return 'changed (secret)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Field-level before → after. */
export function ChangeList({ changes }: { changes: Record<string, unknown> }) {
  const entries = Object.entries(changes ?? {});
  if (!entries.length) return <span className="muted">–</span>;
  return (
    <dl className="audit-changes">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{FIELD_LABEL[k] ?? k.replace(/_/g, ' ')}</dt>
          <dd>
            {isChange(v) ? (
              <>
                <span className="before">{showValue(v.from)}</span> → <span className="after">{showValue(v.to)}</span>
              </>
            ) : (
              showValue(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const CHANNEL: Record<string, string> = { web: 'web', api: 'API', mcp: 'an AI agent (MCP)', system: 'Kernel', email: 'email', email_link: 'an approval link in email', chat_link: 'an approval link in chat', github: 'GitHub' };
const ACTOR_FALLBACK: Record<string, string> = { system: 'Kernel', integration: 'An integration', anonymous: 'Someone', rule: 'An automation rule' };

const VERB: Record<string, string> = {
  create: 'created it', created: 'created it', comment: 'added a note', delete: 'deleted it', classification: 'changed its classification',
  reveal: 'revealed its confidential text', redact_history: 'removed sensitive text', key_moment: 'marked a key moment',
  communication: 'posted a stakeholder update', rule_stopped: 'stopped: too many rules in a row on this record (the loop guard)', page: 'paged on-call', source_override: 'overrode a synced value',
};
const label = (k: string) => FIELD_LABEL[k] ?? k.replace(/_/g, ' ');
const words = (v: unknown) => String(v).replace(/_/g, ' ');
const isShort = (x: unknown) => (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') && String(x).length < 24;

/** "Anna changed priority 3 → 2" – one readable sentence per entry. */
export function describeEntry(e: AuditEntry): string {
  const who = e.actor_name || ACTOR_FALLBACK[e.actor_type] || 'Someone';
  const changes = e.changes ?? {};
  if (e.entity_type === 'ci_upsert') return `${who} synced from ${e.entity_ref || 'a source'}`;
  // A transition: { from, to } at the top, or a status field.
  const move = isChange(changes) ? changes : isChange(changes.status) ? changes.status : null;
  if (move && isShort(move.to)) return `${who} moved it ${isShort(move.from) ? `from ${words(move.from)} ` : ''}to ${words(move.to)}`;
  if (e.action === 'link' && isShort(changes.reference)) return `${who} ${changes.action === 'remove' ? 'removed the link to' : 'linked'} ${changes.reference}`;
  if (e.action === 'major' && isShort(changes.action)) return `${who} ${changes.action === 'declare' ? 'declared a major incident' : `${words(changes.action)} the major incident`}`;
  if (e.action === 'vote' && isShort(changes.decision)) return `${who} voted ${words(changes.decision)}`;
  if (VERB[e.action]) return `${who} ${VERB[e.action]}`;
  // Fields changed to values too long or too private to show are named together: "changed title and description".
  const named = Object.entries(changes).filter(([, v]) => isChange(v) && !(isShort(v.from) && isShort(v.to))).map(([k]) => label(k));
  const parts = Object.entries(changes).map(([k, v]) => {
    if (isChange(v)) return isShort(v.from) && isShort(v.to) ? `changed ${label(k)} ${showValue(v.from)} → ${showValue(v.to)}` : named[0] === label(k) ? `changed ${named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : named[0]}` : null;
    // { affected_person: { id, action: 'add' } }
    if (isObject(v) && isShort(v.action)) return `${v.action === 'add' ? 'added' : v.action === 'remove' ? 'removed' : words(v.action)} ${label(k)}`;
    return null;
  }).filter(Boolean) as string[];
  if (parts.length) return `${who} ${parts.slice(0, 3).join(', ')}${parts.length > 3 ? ` and ${parts.length - 3} more` : ''}`;
  return `${who} ${e.action === 'update' ? 'updated it' : words(e.action)}`;
}

/** Who changed what on a record and how, from the audit trail. The same panel on every record type (#57). */
export function HistoryPanel({ recordRef, version }: { recordRef: string; version?: unknown }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.get<AuditEntry[]>(`/api/records/${recordRef}/history?limit=200`)
      .then((rows) => live && (setEntries(rows), setError(null)))
      .catch((err) => live && setError((err as Error).message));
    return () => { live = false; };
  }, [open, recordRef, version]);

  const shown = entries && (all ? entries : entries.slice(0, 15));
  return (
    <section className="card history-panel">
      <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary><h2>History</h2></summary>
        <p className="muted small">Who changed what, when and how. From the audit trail, which cannot be altered.</p>
        {error && <div className="error">{error}</div>}
        {!entries && !error && <p className="muted small">Loading…</p>}
        {entries?.length === 0 && <p className="placeholder">No changes recorded yet.</p>}
        <ol className="plain-list history-list">
          {shown?.map((e) => (
            <li key={e.id}>
              <button type="button" className="history-line" aria-expanded={expanded === e.id} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                <span>{describeEntry(e)}</span>
                <span className="muted small">
                  <time dateTime={e.at} title={formatDate(e.at)}>{relativeTime(e.at)}</time>
                  {e.channel !== 'system' && <>{' · via '}{e.channel.startsWith('rule:') ? 'an automation rule' : CHANNEL[e.channel] ?? (e.channel || e.actor_type)}{e.token_prefix ? ` (${e.token_prefix}…)` : ''}</>}
                </span>
                {e.reason && <span className="small">Reason: {e.reason}</span>}
              </button>
              {expanded === e.id && <ChangeList changes={e.changes} />}
            </li>
          ))}
        </ol>
        {entries && entries.length > 15 && !all && <button className="btn-link" onClick={() => setAll(true)}>Show all {entries.length}</button>}
      </details>
    </section>
  );
}

const isLong = (v: unknown) => typeof v === 'string' && (v.length > 60 || v.includes('\n'));

/** Before/after for the fields changed by an activity entry: short values inline, long texts behind a toggle. */
function ActivityChanges({ data, skip = [] }: { data: Record<string, unknown>; skip?: string[] }) {
  const { meta } = useSession();
  const [open, setOpen] = useState(false);
  const fmt = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return '–';
    if (k === 'assignee_id') return meta.assignees.find((u) => u.id === v)?.display_name ?? `#${v}`;
    if (k === 'category_id') return meta.categories.find((c) => c.id === v)?.name ?? `#${v}`;
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return String(v);
  };
  const entries = Object.entries(data).filter(([k, v]) => !skip.includes(k) && isChange(v)) as [string, { from: unknown; to: unknown }][];
  const short = entries.filter(([, v]) => !isLong(v.from) && !isLong(v.to));
  const long = entries.filter(([, v]) => isLong(v.from) || isLong(v.to));
  if (!entries.length) return null;
  return (
    <div className="changes">
      {short.map(([k, v]) => (
        <span key={k} className="change-chip">{FIELD_LABEL[k] ?? k}: <s>{fmt(k, v.from)}</s> → <strong>{fmt(k, v.to)}</strong></span>
      ))}
      {long.length > 0 && <button className="btn-link small" onClick={() => setOpen(!open)}>{open ? 'Hide change' : 'Show change'}</button>}
      {open && long.map(([k, v]) => (
        <div key={k} className="text-change">
          <div className="muted small">{FIELD_LABEL[k] ?? k}</div>
          <div className="before"><span className="muted small">Before</span>{v.from ? <Markdown text={String(v.from)} /> : <p className="muted">(empty)</p>}</div>
          <div className="after"><span className="muted small">After</span>{v.to ? <Markdown text={String(v.to)} /> : <p className="muted">(empty)</p>}</div>
        </div>
      ))}
    </div>
  );
}

/** One entry of a problem's work notes and history (the activity the problem record carries). */
export function ActivityLine({ activity: a }: { activity: Activity }) {
  let text: ReactNode;
  switch (a.kind) {
    case 'created':
      text = 'logged the problem';
      break;
    case 'comment':
      text = 'added a note';
      break;
    case 'status':
      text = (
        <>
          moved it from <strong>{PROBLEM_STATUS[a.data.from as Status]}</strong> to <strong>{PROBLEM_STATUS[a.data.to as Status]}</strong>
          {a.data.closure_code && <> ({CLOSURE_LABEL[a.data.closure_code]})</>}
        </>
      );
      break;
    case 'update':
      text = `updated ${Object.keys(a.data).map((k) => FIELD_LABEL[k] ?? k).join(', ')}`;
      break;
    case 'link':
    case 'action':
    case 'analysis':
    case 'assessment':
      text = a.body.charAt(0).toLowerCase() + a.body.slice(1);
      break;
  }
  return (
    <div className={`activity-item kind-${a.kind}`}>
      <div className="activity-head">
        <strong>{a.user_name ?? 'System'}</strong> {text}
        {(a.channel === 'mcp' || a.channel === 'api') && <span className="tag channel" title={a.channel === 'mcp' ? 'Through MCP (an AI agent or MCP client)' : 'Through the REST API'}>via {a.channel.toUpperCase()}</span>}
        {(a.channel === 'email_link' || a.channel === 'chat_link') && <span className="tag channel" title="Decided from the approval link in a notification">via {a.channel === 'email_link' ? 'email' : 'chat'} link</span>}
        <time title={formatDate(a.created_at)}>{relativeTime(a.created_at)}</time>
      </div>
      {(a.kind === 'comment' || (a.kind === 'status' && a.body)) && <Markdown text={a.body} className="activity-body" />}
      {(a.kind === 'update' || a.kind === 'status' || a.kind === 'assessment') && a.data && <ActivityChanges data={a.data} skip={['from', 'to']} />}
    </div>
  );
}
