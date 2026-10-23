// The incident activity log and audit entry, shared by incidents, event rules and SLA clocks.
import { logActivity } from './activity.js';
import type { ActivityEntry } from './records.js';
import { audit } from './audit.js';
import type { Db } from './problems.js';
import { queueRuleRuns } from './rule-queue.js';

export const logIncident = (db: Db, incidentId: number, userId: number | null, kind: string, body = '', data: object = {}) => logActivity(db, 'incident', incidentId, userId, kind, body, data);

/** After an incident history entry: touch it (and a major incident's update countdown), audit, rules. */
export async function afterIncidentLog(db: Db, { recordId: incidentId, kind, body, data }: ActivityEntry) {
  // A stakeholder update on a major incident (#108), from wherever it was posted, restarts the update countdown.
  const cadence = kind === 'communication'
    ? `, major_next_update_at = CASE WHEN is_major AND major_update_minutes IS NOT NULL AND status NOT IN ('resolved', 'closed')
         THEN now() + major_update_minutes * interval '1 minute' ELSE major_next_update_at END, major_overdue_notified_for = NULL`
    : '';
  const { rows } = await db.query(`UPDATE incidents SET updated_at = now()${cadence} WHERE id = $1 RETURNING ref`, [incidentId]);
  await audit(db, { entity_type: 'incident', entity_ref: rows[0].ref, action: kind, changes: kind === 'comment' || kind === 'communication' ? { body } : (data as Record<string, unknown>) });
  await queueRuleRuns(db, 'incident', rows[0].ref, kind, data);
}
