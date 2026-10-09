// The incident activity log and audit entry, shared by incidents, event rules and SLA clocks.
import { audit } from './audit.js';
import { currentContext } from './context.js';
import type { Db } from './problems.js';

export async function logIncident(db: Db, incidentId: number, userId: number | null, kind: string, body = '', data: object = {}) {
  await db.query('INSERT INTO incident_activity (incident_id, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6)', [
    incidentId, userId, kind, body, JSON.stringify(data), currentContext().channel,
  ]);
  const { rows } = await db.query('UPDATE incidents SET updated_at = now() WHERE id = $1 RETURNING ref', [incidentId]);
  await audit(db, { entity_type: 'incident', entity_ref: rows[0].ref, action: kind, changes: kind === 'comment' || kind === 'communication' ? { body } : (data as Record<string, unknown>) });
}
