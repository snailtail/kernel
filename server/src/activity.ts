// The activity log every record kind keeps (#172): one writer and one history query, driven by the record type's
// `activity` (records.ts). What else an entry does – touch the record, audit, rules, notices – is the kind's own
// `after` hook, so a major incident's update cadence or a problem's webhooks stay with their domain.
import { audit } from './audit.js';
import { currentContext } from './context.js';
import { type Db, query } from './db.js';
import { recordType, type ActivityEntry } from './records.js';
import { queueRuleRuns, type RuleKind } from './rule-queue.js';

function logOf(type: string) {
  const t = recordType(type);
  if (!t.activity) throw new Error(`${type} has no activity log of its own`);
  return { t, log: t.activity };
}

/** An entry in the record's history, then what the kind does after one (its `after` hook). */
export async function logActivity(db: Db, type: string, recordId: number, userId: number | null, kind: string, body = '', data: object = {}) {
  const { log } = logOf(type);
  const { rows } = await db.query(`INSERT INTO ${log.table} (${log.fk}, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [
    recordId, userId, kind, body, JSON.stringify(data), currentContext().channel,
  ]);
  await log.after?.(db, { id: rows[0].id, recordId, userId, kind, body, data });
}

/**
 * Only the entry: no audit, rules or notices, for callers that audit on their own (classification, visibility,
 * dev links, SLA clocks). The channel is the column's default unless given.
 */
export async function addEntry(db: Db, type: string, recordId: number, e: { userId: number | null; kind: string; body: string; data?: object; channel?: string }) {
  const { log } = logOf(type);
  await db.query(`INSERT INTO ${log.table} (${log.fk}, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6)`, [
    recordId, e.userId, e.kind, e.body, JSON.stringify(e.data ?? {}), e.channel ?? '',
  ]);
}

/**
 * The usual `after`: the record's updated_at, the audit trail (a comment's text, otherwise the entry's data) and, for
 * the kinds rules run on, the rule queue. Returns the record's ref.
 */
export async function touchAndAudit(db: Db, type: string, e: ActivityEntry, options: { rules?: boolean } = {}) {
  const { t } = logOf(type);
  const { rows } = await db.query(`UPDATE ${t.table} SET updated_at = now() WHERE id = $1 RETURNING ref`, [e.recordId]);
  await audit(db, { entity_type: type, entity_ref: rows[0].ref, action: e.kind, changes: e.kind === 'comment' ? { body: e.body } : (e.data as Record<string, unknown>) });
  if (options.rules) await queueRuleRuns(db, type as RuleKind, rows[0].ref, e.kind, e.data);
  return rows[0].ref as string;
}

/** A record's history, newest first: who (or which automation rule) did what. */
export async function historyOf(type: string, recordId: number) {
  const { log } = logOf(type);
  const extra = (log.columns ?? []).map((c) => `a.${c}, `).join('');
  const { rows } = await query(
    `SELECT a.id, a.kind, a.body, a.data, a.channel, ${extra}a.created_at, coalesce(u.display_name, (SELECT 'Rule ''' || r.name || '''' FROM automation_rules r WHERE a.channel = 'rule:' || r.id)) AS user_name
     FROM ${log.table} a LEFT JOIN users u ON u.id = a.user_id WHERE a.${log.fk} = $1 ORDER BY a.created_at DESC, a.id DESC${log.limit ? ` LIMIT ${log.limit}` : ''}`,
    [recordId],
  );
  return rows;
}
