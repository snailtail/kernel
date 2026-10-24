// Agenda for the regular problem review meeting: everything in the backlog that needs a decision or attention.
import { z } from 'zod';
import { query } from '../core/db.js';
import { overdueActions } from './actions.js';

export const agendaSchema = z.object({ stale_days: z.coerce.number().int().min(1).max(365).default(14) });

const ITEM = `p.ref, p.title, p.status, p.priority, p.is_major, p.assignee_id, a.display_name AS assignee,
  p.affected_service, p.created_at, p.updated_at, p.ec_decision, p.ec_review_date::text AS ec_review_date`;
const FROM = 'FROM problems p LEFT JOIN users a ON a.id = p.assignee_id';
const OPEN = "p.status NOT IN ('resolved', 'closed')";

export async function reviewAgenda({ stale_days }: z.infer<typeof agendaSchema>) {
  const [untriaged, unowned, needsDecision, reviewDue, stale, major, awaitingClosure, overdue] = await Promise.all([
    query(`SELECT ${ITEM} ${FROM} WHERE p.status = 'new' ORDER BY p.priority, p.created_at`),
    query(`SELECT ${ITEM} ${FROM} WHERE ${OPEN} AND p.status <> 'new' AND p.assignee_id IS NULL ORDER BY p.priority, p.created_at`),
    query(`SELECT ${ITEM} ${FROM} WHERE p.status = 'known_error' AND coalesce(p.ec_decision, 'pending') = 'pending' ORDER BY p.priority, p.known_error_at`),
    query(`SELECT ${ITEM} ${FROM} WHERE p.status = 'known_error' AND p.ec_review_date <= current_date ORDER BY p.ec_review_date`),
    query(`SELECT ${ITEM} ${FROM} WHERE ${OPEN} AND p.updated_at < now() - $1 * interval '1 day' ORDER BY p.updated_at`, [stale_days]),
    query(`SELECT ${ITEM} ${FROM} WHERE p.is_major AND (${OPEN} OR (p.status = 'resolved' AND p.major_review = '')) ORDER BY p.priority, p.created_at`),
    query(`SELECT ${ITEM} ${FROM} WHERE p.status = 'resolved' ORDER BY p.resolved_at`),
    overdueActions(['problem']),
  ]);
  return {
    generated_at: new Date().toISOString(),
    stale_days,
    sections: [
      { id: 'untriaged', title: 'New problems to triage', hint: 'Confirm priority, category and owner, check for duplicates, then start analysis.', problems: untriaged.rows },
      { id: 'unowned', title: 'Problems without an owner', hint: 'Every problem in progress needs someone accountable.', problems: unowned.rows },
      { id: 'major', title: 'Major problems', hint: 'Open major problems, and resolved ones still missing their review.', problems: major.rows },
      { id: 'needs_decision', title: 'Known errors awaiting a decision', hint: 'Fix, accept the risk, or defer – with a review date.', problems: needsDecision.rows },
      { id: 'review_due', title: 'Decisions due for review', hint: 'Accepted or deferred risks whose review date has passed.', problems: reviewDue.rows },
      { id: 'stale', title: `No activity for ${stale_days}+ days`, hint: 'Still relevant? Unblock, re-prioritise, or close.', problems: stale.rows },
      { id: 'awaiting_closure', title: 'Resolved, awaiting closure', hint: 'Verify the fix held, then close.', problems: awaitingClosure.rows },
    ],
    overdue_actions: overdue,
  };
}

/** The agenda as Markdown, for sending out before the meeting or pasting into minutes. */
export function agendaMarkdown(agenda: Awaited<ReturnType<typeof reviewAgenda>>) {
  const lines = [`# Problem review – ${agenda.generated_at.slice(0, 10)}`, ''];
  for (const s of agenda.sections) {
    if (!s.problems.length) continue;
    lines.push(`## ${s.title} (${s.problems.length})`, '', `_${s.hint}_`, '');
    for (const p of s.problems) {
      lines.push(`- [ ] **${p.ref}** ${p.title} — P${p.priority}, ${p.status.replace('_', ' ')}, ${p.assignee ?? 'unassigned'}`);
    }
    lines.push('');
  }
  if (agenda.overdue_actions.length) {
    lines.push(`## Overdue follow-up actions (${agenda.overdue_actions.length})`, '');
    for (const a of agenda.overdue_actions) lines.push(`- [ ] **${a.ref}** ${a.title} — ${a.owner ?? 'no owner'}, due ${a.due_date}`);
    lines.push('');
  }
  if (lines.length === 2) lines.push('Nothing needs attention. 🎉', '');
  return lines.join('\n');
}
