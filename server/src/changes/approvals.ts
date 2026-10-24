// Pending approvals: decisions an AI agent requests through MCP (closing a problem, accepting/deferring risk,
// marking a duplicate) are carried out only when a person approves them, in the web UI (#76) or from the approval link
// in their email or chat message (#48).
import { managers, notify } from '../notifications/notifications.js';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from '../security/auth.js';
import { audit } from '../security/audit.js';
import { query, tx } from '../core/db.js';
import { conflict, forbidden, notFound } from '../core/errors.js';
import { authorize, type Action } from '../security/policy.js';
import { assessmentSchema, assessProblem, getProblem, loadForUpdate, logProblem, markDuplicate, transitionProblem, transitionSchema } from '../problems/problems.js';

export type ApprovalKind = 'close' | 'risk_decision' | 'mark_duplicate';
const ACTION: Record<ApprovalKind, Action> = { close: 'problem.close', risk_decision: 'problem.accept_risk', mark_duplicate: 'problem.mark_duplicate' };
/** The permission a person needs to decide a request of this kind. */
export const approvalAction = (kind: ApprovalKind) => ACTION[kind];

export async function approvalsRequired(): Promise<boolean> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'mcp_decisions_require_approval'");
  return rows[0]?.value !== false;
}

export async function setApprovalsRequired(required: boolean, reason: string) {
  await query("INSERT INTO settings (key, value) VALUES ('mcp_decisions_require_approval', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(required)]);
  await audit(null, { entity_type: 'setting', entity_ref: 'mcp_decisions_require_approval', action: 'update', changes: { required }, reason });
  return { required };
}

/** Records a decision an agent asked for; returns what to tell the agent. */
export async function requestApproval(user: User, ref: string, kind: ApprovalKind, payload: object, summary: string, confirmation: string) {
  authorize(user, ACTION[kind]); // the requester must be allowed to make the decision at all
  const id = await tx(async (db) => {
    const p = await loadForUpdate(db, ref);
    const { rows } = await db.query(
      `INSERT INTO pending_approvals (problem_id, kind, payload, summary, requested_by, human_confirmation) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [p.id, kind, JSON.stringify(payload), summary, user.id, confirmation],
    );
    await logProblem(db, p.id, user.id, 'update', `Requested approval: ${summary}`, { approval_id: rows[0].id, approval: 'requested' });
    await notify(db, { users: await managers(db), event: 'approval_needed', ref: p.ref, title: summary, summary: 'An AI agent asked for a decision. Nothing happens until a person approves.', path: `/problems/${p.ref}`, dedupe: `mcp-approval:${rows[0].id}`, approvalId: rows[0].id });
    return rows[0].id as number;
  });
  return {
    pending_approval: id,
    message: `Not carried out yet: a person must approve "${summary}" on ${ref.toUpperCase()} in Kernel's web UI. Tell the user.`,
  };
}

const EXPIRE_DAYS = 14;

/** Marks requests older than 14 days as expired (they are probably no longer what anyone wants). */
async function expireApprovals() {
  await query(`UPDATE pending_approvals SET status = 'expired' WHERE status = 'pending' AND created_at < now() - $1 * interval '1 day'`, [EXPIRE_DAYS]);
}

export async function listApprovals(ref?: string) {
  await expireApprovals();
  const { rows } = await query(
    `SELECT a.id, p.ref, p.title, a.kind, a.summary, a.payload, a.status, a.human_confirmation, a.created_at, a.requested_via,
            ru.display_name AS requested_by, du.display_name AS decided_by, a.decided_at, a.result,
            p.updated_at > a.created_at AS changed_since_request
     FROM pending_approvals a JOIN problems p ON p.id = a.problem_id
     JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
     WHERE ${ref ? 'p.ref = $1' : "a.status = 'pending'"} ORDER BY a.created_at DESC LIMIT 100`,
    ref ? [ref.toUpperCase()] : [],
  );
  return rows;
}

/** A person approves or rejects in the web UI or through their approval link from email or chat (never through an API token or MCP). */
export async function decideApproval(req: FastifyRequest, user: User, id: number, approve: boolean, note?: string) {
  if (req.headers.authorization) throw forbidden('Approvals are decided by a person in the web UI');
  await expireApprovals();
  const { rows: found } = await query('SELECT a.kind FROM pending_approvals a WHERE a.id = $1', [id]);
  if (!found[0]) throw notFound('Approval not found');
  authorize(user, ACTION[found[0].kind as ApprovalKind]);
  // Claim atomically: a double click or two approvers can never carry out the same decision twice.
  const { rows } = await query(
    `UPDATE pending_approvals a SET status = 'processing', decided_by = $2, decided_at = now()
     FROM problems p WHERE a.id = $1 AND a.status = 'pending' AND p.id = a.problem_id
     RETURNING a.*, p.ref`,
    [id, user.id],
  );
  const a = rows[0];
  if (!a) {
    const { rows: current } = await query('SELECT status FROM pending_approvals WHERE id = $1', [id]);
    throw conflict(`This request is already ${current[0].status}`);
  }
  const finish = (status: string, result: string) => query('UPDATE pending_approvals SET status = $2, result = $3 WHERE id = $1', [id, status, result]);
  if (!approve) {
    await finish('rejected', note ?? '');
    await audit(null, { entity_type: 'problem', entity_ref: a.ref, action: 'approval_rejected', changes: { approval_id: id, kind: a.kind }, reason: note });
    return getProblem(a.ref);
  }
  // Carry out the decision as the approving person; the rules (closure codes, reviews…) apply as usual.
  const reason = `Approved request from MCP: ${a.summary}${a.human_confirmation ? ` (agent quoted: "${a.human_confirmation}")` : ''}`;
  try {
    if (a.kind === 'close') await transitionProblem(user, a.ref, transitionSchema.parse({ ...a.payload, comment: [a.payload.comment, reason].filter(Boolean).join('\n\n') }));
    else if (a.kind === 'risk_decision') await assessProblem(user, a.ref, assessmentSchema.parse(a.payload));
    else await markDuplicate(user, a.ref, a.payload.of);
  } catch (err) {
    await finish('failed', (err as Error).message);
    throw err;
  }
  await finish('approved', note ?? '');
  await audit(null, { entity_type: 'problem', entity_ref: a.ref, action: 'approval_approved', changes: { approval_id: id, kind: a.kind }, reason });
  return getProblem(a.kind === 'mark_duplicate' ? a.payload.of : a.ref);
}

export const decisionSchema = z.object({ note: z.string().max(1000).optional() });
