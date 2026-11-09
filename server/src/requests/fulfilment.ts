// Request fulfilment that runs outside a person's hands (part 2 of #44): standard change and webhook tasks, the webhook's callback, and the requester's mail.
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audienceOf, forRequester, startNarrow } from '../security/audience.js';
import type { User } from '../security/auth.js';
import { changeConcluded, createChange, createChangeSchema } from '../changes/changes.js';
import { asSystem, contextStore } from '../core/context.js';
import { type Db, query, tx, USER_COLUMNS } from '../core/db.js';
import { badRequest, HttpError } from '../core/errors.js';
import { moduleEnabled } from '../core/modules.js';
import { notify, sendOutsideMail } from '../notifications/notifications.js';
import { rateLimit } from '../core/ratelimit.js';
import { securityEvent } from '../security/security-events.js';
import { unsubscribeUrl } from '../status/status-subscriptions.js';
import { can } from '../security/policy.js';
import { teamMembers } from '../people/teams.js';
import { absoluteUrl } from '../core/url.js';
import { tokenHashBytes } from '../core/hash.js';
import { processOutbox } from '../core/outbox.js';
import { requestTaskPayload } from '../notifications/webhooks.js';
import { FREE_TEXT, type FormField } from './catalogue.js';
import { finishTask, loadRequest, logRequest, type Notice, requestUrl, taskAutomation, taskWebhook } from './requests.js';

/** How long a webhook task's callback token works. */
const CALLBACK_DAYS = 7;

// ---- Automation (part 2 of #44): the standard change and webhook tasks ---------------------------

/**
 * After a commit that may have opened a task: a standard change task makes its change from the item's template, as
 * narrow as the request (#117), on the CIs the form names (else the service). Done as the acting person when they may
 * create changes, else as the user who logged the request. If the change cannot be made (the module is off, the
 * template's scope refuses it, a change freeze), the history says why and the team does the task by hand.
 */
export async function runAutomation(ref: string, actor?: User) {
  const { rows } = await query(
    `SELECT t.id, t.title, t.team_id, r.id AS request_id, r.ref, r.created_by, r.answers, i.form, i.name AS item, i.standard_change_template_id, c.ref AS service_ref
     FROM request_tasks t JOIN requests r ON r.id = t.request_id JOIN request_items i ON i.id = r.item_id JOIN configuration_items c ON c.id = i.service_id
     WHERE r.ref = $1 AND t.status = 'open' AND t.kind = 'change' AND t.change_id IS NULL AND r.status = 'in_fulfilment'`,
    [ref.toUpperCase()],
  );
  const t = rows[0];
  if (!t) return;
  const log = (body: string, data: object) => tx((db) => logRequest(db, t.request_id, null, 'task', body, data));
  try {
    if (!moduleEnabled('change')) throw badRequest('Changes are turned off');
    if (!t.standard_change_template_id) throw badRequest('The catalogue item no longer names a standard change template');
    const { rows: u } = await query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1 AND u.active`, [t.created_by]);
    const by: User | undefined = actor && can(actor.role, 'change.create') ? actor : u[0];
    if (!by) throw badRequest('Nobody can make the change: the user who logged the request is gone');
    const cis = (t.form as FormField[]).filter((f) => f.type === 'ci' && t.answers[f.key]).map((f) => String(t.answers[f.key]));
    const change = await createChange(by, createChangeSchema.parse({
      title: `${t.item}: ${t.title} (${t.ref})`, description: `Carries out service request ${t.ref}.`, template_id: t.standard_change_template_id,
      cis: cis.length ? cis : [t.service_ref], ...(t.team_id ? { team_id: t.team_id } : {}),
    }), undefined, startNarrow(await audienceOf(null, t.ref)));
    await tx(async (db) => {
      const { rowCount } = await db.query('UPDATE request_tasks SET change_id = $2 WHERE id = $1 AND change_id IS NULL', [t.id, change.id]);
      if (!rowCount) return;
      await db.query("INSERT INTO request_links (request_id, kind, reference, system, created_by) VALUES ($1, 'change', $2, 'Kernel', $3) ON CONFLICT DO NOTHING", [t.request_id, change.ref, by.id]);
      await logRequest(db, t.request_id, null, 'task', `Standard change ${change.ref} made for: ${t.title}. Its outcome completes the task.`, { task: t.id, change: change.ref });
    });
  } catch (err) {
    if (!(err instanceof HttpError) || err.statusCode >= 500) throw err;
    await log(`The standard change could not be made (${err.message}). Do this task by hand.`, { task: t.id, change_error: err.message });
  }
}
taskAutomation.provide(runAutomation);

/** A change's outcome completes the request task it carries out; a failed or rolled back change leaves it open. */
changeConcluded.on(changeOutcome);
async function changeOutcome(changeRef: string) {
  const refs = await asSystem(() => tx(async (db) => {
    const { rows } = await db.query(
      `SELECT t.id AS task_id, t.title AS task_title, t.team_id AS task_team_id, c.ref AS change_ref, c.status AS change_status, c.outcome, r.*
       FROM request_tasks t JOIN changes c ON c.id = t.change_id JOIN requests r ON r.id = t.request_id
       WHERE c.ref = $1 AND t.status = 'open' AND t.kind = 'change' FOR UPDATE OF t, r`,
      [changeRef.toUpperCase()],
    );
    for (const r of rows) {
      const t = { id: r.task_id as number, title: r.task_title as string };
      if (r.outcome === 'successful') await finishTask(db, r, t, null, `${r.change_ref} successful`);
      else {
        const what = r.change_status === 'cancelled' ? 'was cancelled' : `was ${String(r.outcome ?? r.change_status).replace('_', ' ')}`;
        await logRequest(db, r.id, null, 'task', `${r.change_ref} ${what}: "${t.title}" stays open. Raise a new change, or do it by hand.`, { task: t.id, change: r.change_ref, outcome: r.outcome });
        if (r.task_team_id) await notify(db, { users: await teamMembers(db, r.task_team_id), event: 'team_queue', ref: r.ref, title: r.title, summary: `${r.change_ref} ${what}: ${t.title} needs you.`, path: `/requests/${r.ref}`, dedupe: `request-change:${t.id}:${r.change_ref}:${r.outcome ?? r.change_status}` });
      }
    }
    return rows.map((x) => x.ref as string);
  }));
  for (const ref of new Set(refs)) await asSystem(() => runAutomation(ref));
}

/**
 * A webhook task is queued for its webhook with the request's ref, item and answers: never comments or task notes,
 * no free-text answers from a confidential request, and only the ref of a restricted one. The callback token is added
 * when the delivery is sent (withCallback), so the queue never holds it.
 */
taskWebhook.provide(queueTaskWebhook);
async function queueTaskWebhook(db: Db, requestId: number, t: { id: number; title: string; webhook_id: number }) {
  const { rows } = await db.query(
    `SELECT r.ref, r.title, r.status, r.answers, r.restricted, r.classification, i.name AS item, i.form, c.ref AS service_ref, c.name AS service_name, t.position
     FROM requests r JOIN request_items i ON i.id = r.item_id JOIN configuration_items c ON c.id = i.service_id JOIN request_tasks t ON t.id = $2 WHERE r.id = $1`,
    [requestId, t.id],
  );
  const r = rows[0];
  const answers = r.restricted ? {} : Object.fromEntries((r.form as FormField[]).filter((f) => r.answers[f.key] !== undefined && !(FREE_TEXT.has(f.type) && r.classification === 'confidential')).map((f) => [f.key, r.answers[f.key]]));
  const payload = {
    event: 'request.task', occurred_at: new Date().toISOString(),
    request: r.restricted ? { ref: r.ref, restricted: true, url: requestUrl(r.ref) } : { ref: r.ref, title: r.title, item: r.item, service: { ref: r.service_ref, name: r.service_name }, url: requestUrl(r.ref) },
    task: { id: t.id, title: t.title, position: r.position },
    answers,
    problem: null, actor: null, summary: `Task: ${t.title}`, data: { request_task_id: t.id },
  };
  await db.query("INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, 'request.task', $2)", [t.webhook_id, JSON.stringify(payload)]);
  await logRequest(db, requestId, null, 'task', `Sent to its webhook: ${t.title}`, { task: t.id, webhook: t.webhook_id });
}

/**
 * Called by the webhook worker as it sends a request.task delivery: mints the task's callback token (256 random bits,
 * only the SHA-256 kept, single use, expires) and adds where to call back. A retry mints a new one, so the token in a
 * failed attempt stops working. Null when the task is no longer open: nothing is sent.
 */
requestTaskPayload.provide(withCallback);
async function withCallback(payload: any) {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await query(
    `UPDATE request_tasks SET callback_hash = $2, callback_expires_at = now() + $3 * interval '1 day', callback_used_at = NULL
     WHERE id = $1 AND status = 'open' AND kind = 'webhook' RETURNING callback_expires_at`,
    [payload?.task?.id, tokenHashBytes(token), CALLBACK_DAYS],
  );
  if (!rows[0]) return null;
  return {
    ...payload,
    callback: {
      url: absoluteUrl(`/api/requests/${payload.request.ref}/tasks/${payload.task.id}/complete`), method: 'POST', header: 'X-Kernel-Task-Token', token,
      expires_at: new Date(rows[0].callback_expires_at).toISOString(), body: '{ "status": "done" | "failed", "note": "…" }',
    },
  };
}

export const callbackSchema = z.object({ status: z.enum(['done', 'failed']).default('done'), note: z.string().trim().max(2000).default('') });

/** The webhook's receiver reports back with the task's token: done completes the task, failed hands it to the team. */
export async function completeTaskByToken(req: FastifyRequest, ref: string, taskId: number, token: string, input: z.infer<typeof callbackSchema>) {
  rateLimit(`task-callback:ip:${req.ip}`, 60, 60_000);
  const refuse = (reason: string) => {
    securityEvent({ action: 'request_task.callback_refused', category: 'authentication', outcome: 'denied', message: `Task callback refused: ${reason}`, detail: { reason, task_id: taskId } }, req);
    return new HttpError(403, 'This callback token is not valid for that task, or it was used or has expired');
  };
  if (!token || token.length > 100) throw refuse('missing');
  const ctx = { userId: null, userName: 'webhook', actorType: 'system' as const, channel: 'webhook', tokenPrefix: '', ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300), requestId: String(req.id), viewer: 'system' };
  await contextStore.run(ctx, () => tx(async (db) => {
    const { rows } = await db.query(
      `SELECT t.*, t.callback_expires_at < now() AS expired, r.ref AS request_ref FROM request_tasks t JOIN requests r ON r.id = t.request_id
       WHERE t.id = $1 AND r.ref = $2 AND t.callback_hash = $3 FOR UPDATE OF t`,
      [taskId, ref.toUpperCase(), tokenHashBytes(token)],
    );
    const t = rows[0];
    if (!t) throw refuse('invalid');
    if (t.callback_used_at) throw refuse('used');
    if (t.expired) throw refuse('expired');
    if (t.status !== 'open') throw refuse('not_open');
    await db.query('UPDATE request_tasks SET callback_used_at = now() WHERE id = $1', [t.id]);
    const r = await loadRequest(db, ref);
    if (input.status === 'done') await finishTask(db, r, t, null, input.note);
    else {
      await logRequest(db, r.id, null, 'task', `The webhook reports it could not do "${t.title}"${input.note ? `: ${input.note}` : ''}. The task stays open for a person.`, { task: t.id, webhook: 'failed', ...(input.note ? { note: input.note } : {}) });
      if (t.team_id) await notify(db, { users: await teamMembers(db, t.team_id), event: 'team_queue', ref: r.ref, title: r.title, summary: `Automation failed: ${t.title} needs a person.`, path: `/requests/${r.ref}`, dedupe: `request-webhook-failed:${t.id}` });
    }
  }));
  await asSystem(() => runAutomation(ref));
  return { ok: true, status: input.status };
}

// ---- The requester hears about it (part 2 of #44) ----------------------------------------------

/** What the mail says, in plain words: only the request's own title (not for a restricted one) and where it stands. */
function requesterLines(kind: Notice, r: { ref: string; title: string | null; approval: boolean }) {
  const what = r.title ? `"${r.title}" (${r.ref})` : r.ref;
  const lines: Record<Notice, [string, string[]]> = {
    received: ['we have received it', [`We have received your request ${what}.`, r.approval ? 'It needs an approval first. We will tell you when it is approved and when it is done.' : 'We will tell you when it is done.']],
    approved: ['approved', [`Your request ${what} has been approved. We are working on it now.`]],
    rejected: ['not approved', [`Your request ${what} was not approved.`, 'If you have questions, contact your service desk.']],
    fulfilled: ['done', [`Your request ${what} is done.`]],
    cancelled: ['cancelled', [`Your request ${what} has been cancelled.`, 'If you still need it, contact your service desk.']],
  };
  const [subject, body] = lines[kind];
  return { subject: `Your request ${r.ref}: ${subject}`, lines: body };
}

/** Sends due requester mail; claimed with a lease so replicas never send the same one twice. */
export async function processRequestMail(limit = 20) {
  const { sent } = await processOutbox({
    table: 'request_mail', leaseSeconds: 120, limit, permanent: /not configured/,
    retryIn: (attempts) => (attempts >= 5 ? null : 2 ** attempts * 60),
    send: async (m: any) => {
      const { rows: p } = await query("SELECT email FROM people WHERE id = $1 AND request_mail AND active AND erased_at IS NULL AND coalesce(email, '') <> ''", [m.person_id]);
      const r = await forRequester(null, m.request_id);
      if (!p[0] || !r) return 'skipped';
      const { subject, lines } = requesterLines(m.kind, r);
      await sendOutsideMail(p[0].email, subject, lines, unsubscribeUrl('r', m.person_id));
    },
  });
  return sent;
}
