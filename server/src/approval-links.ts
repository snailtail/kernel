// Approve or reject from email and chat (#48). An approval_needed email or chat message carries Approve and Reject
// links with an action token, minted when the message is sent: 256 random bits, of which only the SHA-256 is stored,
// bound to one approver, one approval and the version of what is to be decided. GET never changes anything (mail
// scanners such as Safe Links open every link); it shows the request and a form, and the POST decides, once, as the
// approver. Emergency and high-risk changes are not decided by link: the page asks the approver to sign in.
// See docs/approval-links.md.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { approvalAction, decideApproval, type ApprovalKind } from './approvals.js';
import { audit } from './audit.js';
import { USER_COLUMNS, type User } from './auth.js';
import { RISKS, changePolicy, getChange, voteOnChange } from './changes.js';
import { asSystem, contextStore, type RequestContext } from './context.js';
import { query } from './db.js';
import { decideRequest, requestForApprover } from './requests.js';
import { badRequest, HttpError } from './errors.js';
import { mfaRequiredFor } from './mfapolicy.js';
import { APPROVAL_LINK_HOURS } from './notifications.js';
import { can } from './policy.js';
import { rateLimit } from './ratelimit.js';
import { securityEvent } from './security-events.js';
import { viewerFor } from './visibility.js';
import { absoluteUrl } from './core/url.js';
import { sha256 } from './core/hash.js';


/** The form on the GET page carries this instead of the token itself; it proves the POST comes from that page. */
const formTokenOf = (token: string, linkId: number) => createHmac('sha256', token).update(`kernel-approval-form:${linkId}`).digest('base64url');

/** Runs fn as the approver: their row-level visibility, and the audit trail shows them, through the link's channel. */
async function asApprover<T>(user: User, base: Partial<RequestContext>, fn: () => Promise<T>) {
  const viewer = await viewerFor(user, 'web');
  const ctx: RequestContext = {
    userId: user.id, userName: user.username, actorType: 'user', channel: 'system', tokenPrefix: '', ip: '', userAgent: '', requestId: '', ...base, viewer,
  };
  return contextStore.run(ctx, fn);
}

interface Subject {
  kind: 'change' | 'mcp' | 'request';
  ref: string;
  title: string;
  /** Still waiting for this approver's decision. */
  open: boolean;
  version: string;
  deadline: Date | null;
  /** Emergency or high risk: decided only after signing in. */
  signIn: boolean;
  facts: [string, string][];
  path: string;
}

const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('base64url');
const when = (d: string | Date | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'not planned');

/** What the approver is asked to decide, read as the approver (null when they cannot see it). */
async function subjectOf(user: User, target: { change_id?: number | null; approval_id?: number | null; request_id?: number | null }): Promise<Subject | null> {
  if (target.request_id) {
    // A service request (#44) waiting for this approver.
    const r = await requestForApprover(user, target.request_id);
    if (!r) return null;
    return { kind: 'request', ref: r.ref, title: r.title, open: r.open, version: fingerprint(r.version), deadline: null, signIn: false, facts: r.facts, path: `/requests/${r.ref}` };
  }
  if (target.change_id) {
    const { rows } = await query('SELECT ref FROM changes WHERE id = $1', [target.change_id]);
    if (!rows[0] || !can(user.role, 'change.read')) return null;
    const c = await getChange(user, rows[0].ref);
    const pol = await changePolicy();
    const start = c.planned_start ? new Date(c.planned_start) : null;
    return {
      kind: 'change',
      ref: c.ref,
      title: c.title,
      open: c.can_vote,
      // What the change authority approves: type, risk, plans, window and the CIs it touches.
      version: fingerprint([c.change_type, c.risk, c.implementation_plan, c.backout_plan, c.test_plan, c.planned_start && start!.toISOString(), c.planned_end && new Date(c.planned_end).toISOString(), c.affected_cis.map((ci: { ref: string }) => ci.ref).sort()]),
      deadline: start && start.getTime() > Date.now() ? start : null,
      signIn: c.change_type === 'emergency' || RISKS.indexOf(c.risk) > (RISKS as readonly string[]).indexOf(pol.link_max_risk),
      facts: [['Type', c.change_type], ['Risk', `${c.risk} (${c.risk_reason})`], ['Window', `${when(c.planned_start)} – ${when(c.planned_end)}`], ['Requested by', c.requested_by ?? ''], ['Approvals', `${c.approvals.approved} of ${c.approvals.required}`]],
      path: `/changes/${c.ref}`,
    };
  }
  const { rows } = await query(
    `SELECT a.id, a.kind, a.summary, a.status, a.created_at, p.ref, p.title, p.updated_at, u.display_name AS requested_by
     FROM pending_approvals a JOIN problems p ON p.id = a.problem_id JOIN users u ON u.id = a.requested_by WHERE a.id = $1`,
    [target.approval_id],
  );
  const a = rows[0];
  if (!a) return null;
  const deadline = new Date(new Date(a.created_at).getTime() + 14 * 86400_000);
  return {
    kind: 'mcp',
    ref: a.ref,
    title: a.title,
    open: a.status === 'pending' && deadline.getTime() > Date.now() && can(user.role, approvalAction(a.kind as ApprovalKind)),
    // The problem as it was when the request was sent; any later change means the approver should look again.
    version: fingerprint([a.id, new Date(a.updated_at).toISOString()]),
    deadline,
    // Accepting or deferring a risk is decided signed in, like a high-risk change.
    signIn: a.kind === 'risk_decision',
    facts: [['Decision', a.summary], ['Requested by', `${a.requested_by} through an AI agent (MCP)`], ['Requested', when(a.created_at)]],
    path: `/problems/${a.ref}`,
  };
}

export interface ApprovalLinks { approve: string; reject: string }

/**
 * Mints a link for one delivery of an approval_needed notification (run by the delivery worker). Returns the links,
 * 'sign_in' when the decision needs a signed-in approver, or null when there is nothing for this person to decide.
 */
export async function mintApprovalLink(n: { ref: string; approval_id: number | null }, userId: number, channel: 'email' | 'chat', deliveryId: number): Promise<ApprovalLinks | 'sign_in' | null> {
  const target: { approval_id?: number; change_id?: number; request_id?: number } | null = n.approval_id
    ? { approval_id: n.approval_id }
    : n.ref.startsWith('CHG') ? { change_id: (await query('SELECT id FROM changes WHERE ref = $1', [n.ref])).rows[0]?.id }
    : n.ref.startsWith('REQ') ? { request_id: (await query('SELECT id FROM requests WHERE ref = $1', [n.ref])).rows[0]?.id }
    : null;
  if (!target || !(target.approval_id || target.change_id || target.request_id)) return null;
  const { rows: u } = await query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1 AND u.active`, [userId]);
  if (!u[0]) return null;
  const user = u[0] as User;
  const s = await asApprover(user, { channel: 'system', actorType: 'system' }, () => subjectOf(user, target));
  if (!s?.open) return null;
  if (s.signIn || (await needsSession(user))) return 'sign_in';
  // A retried delivery sends a new link; the one in the failed attempt never arrived, but is revoked all the same.
  await query('UPDATE approval_links SET revoked_at = now() WHERE delivery_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [deliveryId]);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Math.min(Date.now() + APPROVAL_LINK_HOURS * 3600_000, s.deadline?.getTime() ?? Infinity));
  await query(
    'INSERT INTO approval_links (token_hash, user_id, change_id, approval_id, request_id, version, channel, delivery_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [sha256(token), user.id, target.change_id ?? null, target.approval_id ?? null, target.request_id ?? null, s.version, channel, deliveryId, expires],
  );
  const base = absoluteUrl(`/api/public/approval-links?token=${token}`);
  return { approve: `${base}&decision=approve`, reject: `${base}&decision=reject` };
}

/** Accounts that must change their password or set up required MFA first are sent to sign in. */
async function needsSession(user: User) {
  return user.must_change_password || (!user.mfa_enabled && (await mfaRequiredFor(user.role)));
}

// ---- Using a link ------------------------------------------------------------------------------

type Refusal = 'invalid' | 'used' | 'expired' | 'decided' | 'changed' | 'sign_in';
const REFUSALS: Record<Refusal, string> = {
  invalid: 'This link is not valid.',
  used: 'This link has already been used.',
  expired: 'This link has expired.',
  decided: 'There is nothing left for you to decide here: it was decided, withdrawn or you no longer approve it.',
  changed: 'What you were asked to approve has changed since the link was sent. Open it in Kernel to see the current version.',
  sign_in: 'This decision needs you to sign in: it is an emergency or high-risk change or a risk decision, or your account needs attention first.',
};

export type LinkState =
  | { ok: true; id: number; user: User; subject: Subject; target: { change_id: number | null; approval_id: number | null; request_id: number | null }; channel: 'email' | 'chat'; formToken: string }
  | { ok: false; reason: Refusal; message: string; path?: string };

/** Checks a link without changing anything; refusals are security events. */
export async function checkApprovalLink(req: FastifyRequest, token: string): Promise<LinkState> {
  rateLimit(`approval-link:ip:${req.ip}`, 120, 60_000);
  const hash = sha256(token);
  rateLimit(`approval-link:t:${hash.toString('hex').slice(0, 32)}`, 10, 600_000);
  const refuse = (reason: Refusal, linkId?: number, userId?: number, path?: string): LinkState => {
    securityEvent({
      // Mail scanners reopen links that were used, expired or decided: routine, so info. An unknown token is denied.
      action: 'approval_link.refused', category: 'authentication', outcome: reason === 'invalid' ? 'denied' : 'info',
      message: `Approval link refused: ${reason}`, userId: userId ?? null, detail: { reason, ...(linkId ? { link_id: linkId } : {}) },
    }, req);
    return { ok: false, reason, message: REFUSALS[reason], path };
  };
  // The link is looked up as the system: an anonymous request sees no restricted rows. What it may show is then read
  // as the approver.
  const { rows } = await asSystem(() => query(
    `SELECT l.id AS link_id, l.change_id, l.approval_id, l.request_id, l.version, l.channel, l.expires_at < now() AS expired, l.used_at IS NOT NULL AS used,
            l.revoked_at IS NOT NULL AS revoked, u.active, ${USER_COLUMNS}
     FROM approval_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = $1`,
    [hash],
  ));
  const l = rows[0];
  if (!l) return refuse('invalid');
  const { link_id, change_id, approval_id, request_id, version, channel, expired, used, revoked, active, ...user } = l;
  const id = Number(link_id);
  if (used) return refuse('used', id, user.id);
  if (revoked || !active) return refuse('decided', id, user.id);
  if (expired) return refuse('expired', id, user.id);
  const subject = await asApprover(user, { ip: req.ip }, () => subjectOf(user, { change_id, approval_id, request_id }));
  if (!subject?.open) return refuse('decided', id, user.id);
  if (subject.version !== version) return refuse('changed', id, user.id, subject.path);
  if (subject.signIn || (await needsSession(user))) return refuse('sign_in', id, user.id, subject.path);
  return { ok: true, id, user, subject, target: { change_id, approval_id, request_id }, channel, formToken: formTokenOf(token, id) };
}

/**
 * Decides through a link: the form token from the GET page, the same origin, a comment to reject. The link is
 * claimed first (single use), then the decision is made as the approver through the same service as in the web UI.
 */
export async function useApprovalLink(req: FastifyRequest, token: string, input: { decision: string; comment: string; form: string }) {
  const state = await checkApprovalLink(req, token);
  if (!state.ok) return state;
  const given = Buffer.from(input.form);
  const expected = Buffer.from(state.formToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    securityEvent({ action: 'approval_link.refused', category: 'authentication', outcome: 'denied', message: 'Approval link refused: form token', userId: state.user.id, detail: { reason: 'form_token', link_id: state.id } }, req);
    throw badRequest('Open the link again and use the form on that page');
  }
  if (!['approve', 'reject'].includes(input.decision)) throw badRequest('Choose approve or reject');
  const comment = input.comment.trim().slice(0, 5000);
  if (input.decision === 'reject' && !comment) throw badRequest('Give a reason for rejecting');
  const { rows: claimed } = await asSystem(() => query(
    'UPDATE approval_links SET used_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id',
    [state.id],
  ));
  if (!claimed[0]) return { ok: false as const, reason: 'used' as Refusal, message: REFUSALS.used };
  const { user, subject, channel, target } = state;
  const ctx = { channel: `${channel}_link`, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300), requestId: String(req.id) };
  try {
    await asApprover(user, ctx, async () => {
      if (subject.kind === 'change') await voteOnChange(user, subject.ref, { decision: input.decision as 'approve' | 'reject', comment });
      else if (subject.kind === 'request') await decideRequest(user, subject.ref, { decision: input.decision as 'approve' | 'reject', comment });
      else await decideApproval(req, user, state.target.approval_id!, input.decision === 'approve', comment || undefined);
      // The link's id, never the token: enough to find the delivery it came with.
      await audit(null, { entity_type: subject.kind === 'mcp' ? 'problem' : subject.kind, entity_ref: subject.ref, action: 'decided_by_link', changes: { link_id: state.id, decision: input.decision, channel: ctx.channel } });
    });
  } catch (err) {
    // Nothing was decided: the link may be used again (e.g. after a refusal the approver can correct).
    await asSystem(() => query('UPDATE approval_links SET used_at = NULL WHERE id = $1', [state.id]));
    if (err instanceof HttpError && err.statusCode < 500) return { ok: false as const, reason: 'decided' as Refusal, message: err.message, path: subject.path };
    throw err;
  }
  // The same request may have reached this approver by email and chat: those copies stop working too.
  await asSystem(() => query(
    'UPDATE approval_links SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND used_at IS NULL AND revoked_at IS NULL AND (change_id = $3 OR approval_id = $4 OR request_id = $5)',
    [user.id, state.id, target.change_id, target.approval_id, target.request_id],
  ));
  return { ok: true as const, message: input.decision === 'approve' ? `You approved ${subject.ref}.` : `You rejected ${subject.ref}.`, path: subject.path };
}
