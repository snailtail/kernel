// Pending approvals: decisions an AI agent requests through MCP (closing a problem, accepting/deferring risk,
// marking a duplicate) are carried out only when a person approves them in the web UI (#76).
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { query, tx } from './db.js';
import { conflict, forbidden, notFound } from './errors.js';
import { authorize, type Action } from './policy.js';
import { assessmentSchema, assessProblem, getProblem, loadForUpdate, logActivity, markDuplicate, transitionProblem, transitionSchema } from './problems.js';

export type ApprovalKind = 'close' | 'risk_decision' | 'mark_duplicate';
const ACTION: Record<ApprovalKind, Action> = { close: 'problem.close', risk_decision: 'problem.accept_risk', mark_duplicate: 'problem.mark_duplicate' };

export async function approvalsRequired(): Promise<boolean> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'mcp_decisions_require_approval'");
  return rows[0]?.value !== false;
}

export async function setApprovalsRequired(actor: User, required: boolean, reason: string) {
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
    await logActivity(db, p.id, user.id, 'update', `Requested approval: ${summary}`, { approval_id: rows[0].id, approval: 'requested' });
    return rows[0].id as number;
  });
  return {
    pending_approval: id,
    message: `Not carried out yet: a person must approve "${summary}" on ${ref.toUpperCase()} in Kernel's web UI. Tell the user.`,
  };
}

export async function listApprovals(ref?: string) {
  const { rows } = await query(
    `SELECT a.id, p.ref, p.title, a.kind, a.summary, a.status, a.human_confirmation, a.created_at, a.requested_via,
            ru.display_name AS requested_by, du.display_name AS decided_by, a.decided_at, a.result
     FROM pending_approvals a JOIN problems p ON p.id = a.problem_id
     JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
     WHERE ${ref ? 'p.ref = $1' : "a.status = 'pending'"} ORDER BY a.created_at DESC LIMIT 100`,
    ref ? [ref.toUpperCase()] : [],
  );
  return rows;
}

/** A person approves or rejects in the web UI (never through a token or MCP). */
export async function decideApproval(req: FastifyRequest, user: User, id: number, approve: boolean, note?: string) {
  if (req.headers.authorization) throw forbidden('Approvals are decided by a person in the web UI');
  const { rows } = await query(
    `SELECT a.*, p.ref FROM pending_approvals a JOIN problems p ON p.id = a.problem_id WHERE a.id = $1`,
    [id],
  );
  const a = rows[0];
  if (!a) throw notFound('Approval not found');
  if (a.status !== 'pending') throw conflict(`Already ${a.status}`);
  authorize(user, ACTION[a.kind as ApprovalKind]);
  if (!approve) {
    await query(`UPDATE pending_approvals SET status = 'rejected', decided_by = $2, decided_at = now(), result = $3 WHERE id = $1`, [id, user.id, note ?? '']);
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
    await query(`UPDATE pending_approvals SET status = 'failed', decided_by = $2, decided_at = now(), result = $3 WHERE id = $1`, [id, user.id, (err as Error).message]);
    throw err;
  }
  await query(`UPDATE pending_approvals SET status = 'approved', decided_by = $2, decided_at = now(), result = $3 WHERE id = $1`, [id, user.id, note ?? '']);
  await audit(null, { entity_type: 'problem', entity_ref: a.ref, action: 'approval_approved', changes: { approval_id: id, kind: a.kind }, reason });
  return getProblem(a.payload.of && a.kind === 'mark_duplicate' ? a.payload.of : a.ref);
}

export const decisionSchema = z.object({ note: z.string().max(1000).optional() });
