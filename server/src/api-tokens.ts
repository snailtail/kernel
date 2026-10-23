// Personal API tokens for MCP clients and scripts: each person lists, creates, rotates and revokes their own.
import { z } from 'zod';
import { audit } from './audit.js';
import { createApiToken, TOKEN_MAX_DAYS, TOKEN_SCOPES, type User } from './auth.js';
import { query } from './db.js';
import { badRequest, notFound } from './errors.js';

export async function listTokens(user: User) {
  const { rows } = await query(
    'SELECT id, name, prefix, scopes, created_at, last_used_at, last_used_ip, expires_at FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
    [user.id],
  );
  return rows;
}

export const tokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  expires_in_days: z.number().int().min(1).max(TOKEN_MAX_DAYS).default(90),
  // Least privilege by default: read only (integration accounts: ingest only).
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).optional(),
});

export async function issueToken(user: User, input: z.infer<typeof tokenSchema>) {
  const scopes = input.scopes ?? (user.role === 'integration' ? ['ingest'] : ['read']);
  if (user.role === 'integration' && scopes.some((s) => s !== 'ingest' && s !== 'read')) throw badRequest('Integration accounts can only have read and ingest tokens');
  const created = await createApiToken(user.id, input.name, input.expires_in_days, [...new Set(scopes)]);
  await audit(null, { entity_type: 'api_token', entity_ref: created.prefix, action: 'create', changes: { name: input.name, scopes: created.scopes, expires_at: created.expires_at } });
  return created;
}

/**
 * Rotation without downtime (#75): a successor with the same name, scopes and lifetime; the old token keeps working
 * for 24 hours (or until it expires, if sooner) so integrations can switch over.
 */
export async function rotateToken(user: User, id: number) {
  const { rows } = await query(
    `SELECT id, name, scopes, prefix, greatest(1, ceil(extract(epoch FROM (expires_at - created_at)) / 86400))::int AS days
     FROM api_tokens WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND rotated_to IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [id, user.id],
  );
  if (!rows[0]) throw notFound('No active token with that id');
  const successor = await createApiToken(user.id, rows[0].name, Math.min(rows[0].days ?? 90, TOKEN_MAX_DAYS), rows[0].scopes);
  await query("UPDATE api_tokens SET rotated_to = $2, expires_at = least(coalesce(expires_at, now() + interval '1 day'), now() + interval '1 day') WHERE id = $1", [rows[0].id, successor.id]);
  await audit(null, { entity_type: 'api_token', entity_ref: rows[0].prefix, action: 'rotate', changes: { successor: successor.prefix, overlap_hours: 24 } });
  return { ...successor, previous_expires_in_hours: 24 };
}

export async function revokeToken(user: User, id: number) {
  const { rows } = await query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING prefix, name', [id, user.id]);
  if (!rows[0]) throw notFound();
  await audit(null, { entity_type: 'api_token', entity_ref: rows[0].prefix, action: 'revoke', changes: { name: rows[0].name } });
}
