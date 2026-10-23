// The outbox pattern every queued delivery shares (notifications, status and request mail, portal mail, scheduled
// reports, webhooks): due rows are claimed with a lease in one statement, sent without holding a connection, and
// each row is then marked sent, skipped, retried with backoff or failed. Safe with several replicas: FOR UPDATE
// SKIP LOCKED keeps two claims apart, and a lease that runs out (a crashed replica) lets the row be claimed again.
import { query } from '../db.js';

/** Thrown by send: the row is marked skipped with this reason, and not tried again. */
export class SkipDelivery extends Error {}

/** Thrown by send: the row fails now with this reason, without retries. */
export class GiveUp extends Error {}

/** Column names and the status a delivered row gets; webhooks predate the shared names and keep their own (API fields). */
interface Columns { lease: string; error: string; sentAt: string; sent: string; noError: string | null }
const COLUMNS: Columns = { lease: 'lease_until', error: 'error', sentAt: 'sent_at', sent: 'sent', noError: '' };

export interface Outbox<Row> {
  table: string;
  /** How long a claim holds, in seconds, before another replica may take the row again. */
  leaseSeconds: number;
  limit: number;
  /** An extra condition on the claim, with its parameters numbered from $2. */
  filter?: { sql: string; params: unknown[] };
  /** The claim order; the oldest row first by default. */
  order?: string;
  /** Seconds until the next try after the given number of failed attempts, or null to give up. */
  retryIn: (attempts: number, row: Row) => number | null;
  /** Errors that no retry fixes, such as mail that is not configured. */
  permanent?: RegExp;
  columns?: Partial<Columns>;
  /**
   * Sends one row: returns 'skipped' when there was nothing to send, throws to retry. Columns set on `extra` are
   * written with the outcome (a webhook's response status).
   */
  send: (row: Row, extra: Record<string, unknown>) => Promise<'sent' | 'skipped' | void>;
}

/** Retries after the given minutes, one step per failed attempt, then gives up. */
export const backoffMinutes = (...steps: number[]) => (attempts: number) => (attempts <= steps.length ? steps[attempts - 1] * 60 : null);

/** Claims and sends due rows; returns how many were claimed and how many were sent. */
export async function processOutbox<Row extends { id: number | string; attempts: number }>(box: Outbox<Row>) {
  const c = { ...COLUMNS, ...box.columns };
  const { rows } = await query(
    `UPDATE ${box.table} o SET status = 'sending', ${c.lease} = now() + interval '${box.leaseSeconds} seconds'
     FROM (SELECT id FROM ${box.table} WHERE (status = 'pending' OR (status = 'sending' AND ${c.lease} < now())) AND next_attempt_at <= now()
             ${box.filter ? `AND ${box.filter.sql}` : ''}
           ORDER BY ${box.order ?? 'id'} LIMIT $1 FOR UPDATE SKIP LOCKED) due
     WHERE o.id = due.id
     RETURNING o.*`,
    [box.limit, ...(box.filter?.params ?? [])],
  );
  let sent = 0;
  for (const row of rows as Row[]) {
    const extra: Record<string, unknown> = {};
    const attempts = row.attempts + 1;
    let status: string;
    let error = c.noError;
    let retry: number | null = null;
    try {
      status = (await box.send(row, extra)) === 'skipped' ? 'skipped' : c.sent;
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
      if (err instanceof SkipDelivery) status = 'skipped';
      else {
        retry = err instanceof GiveUp || box.permanent?.test(error) ? null : box.retryIn(attempts, row);
        status = retry === null ? 'failed' : 'pending';
      }
    }
    if (status === c.sent) sent++;
    const cols = Object.keys(extra);
    await query(
      `UPDATE ${box.table} SET status = $2, attempts = $3, ${c.error} = $4, ${c.lease} = NULL,
         ${c.sentAt} = CASE WHEN $2 = '${c.sent}' THEN now() END,
         next_attempt_at = CASE WHEN $5::int IS NULL THEN next_attempt_at ELSE now() + $5::int * interval '1 second' END
         ${cols.map((k, i) => `, ${k} = $${i + 6}`).join('')}
       WHERE id = $1`,
      [row.id, status, attempts, error, retry, ...cols.map((k) => extra[k])],
    );
  }
  return { claimed: rows.length, sent };
}
