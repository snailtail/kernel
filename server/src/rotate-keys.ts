// Re-encrypts every stored secret under the active key (#63). Safe to run while Kernel serves requests: each value
// is replaced in one statement, and every key in the keyring keeps working for reading until the old one is removed.
//
//   docker compose exec app node server/dist/rotate-keys.js         (in the container)
//   npx tsx src/rotate-keys.ts                                      (development)
//
// Steps: add the new key to KERNEL_SECRET_KEYS and make it active (KERNEL_SECRET_KEY_ID), restart, run this, then
// remove an old key only when the security status shows that nothing (secrets or audit entries) uses it.
import { pathToFileURL } from 'node:url';
import { audit } from './audit.js';
import { query } from './db.js';
import { activeKey } from './keys.js';
import { decryptSecret, encryptSecret, keyIdOf } from './secrets.js';

/** Every column holding an encrypted secret. A new one must be added here (and is checked by a test). */
export const SECRET_COLUMNS: [table: string, column: string][] = [
  ['webhooks', 'secret'],
  ['event_sources', 'signing_secret'],
  ['connectors', 'secret'],
  ['dev_sources', 'webhook_secret'],
  ['dev_sources', 'api_token'],
  ['ai_providers', 'api_key'],
  ['notification_settings', 'chat_url'],
  ['users', 'mfa_secret'],
  ['paging_targets', 'secret'],
];
/** Secrets inside settings documents: [settings key, field]. */
export const SECRET_SETTINGS: [key: string, field: string][] = [['sso', 'client_secret_enc']];

const tableExists = async (t: string) => (await query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${t}`])).rows[0].ok as boolean;

export async function rotateSecrets() {
  const active = activeKey();
  if (!active) throw new Error('No key is configured');
  const counts: Record<string, number> = {};
  for (const [table, column] of SECRET_COLUMNS) {
    if (!(await tableExists(table))) continue;
    const pk = table === 'notification_settings' ? 'user_id' : 'id';
    const { rows } = await query(`SELECT ${pk} AS pk, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT LIKE $1`, [`v2:${active.id}:%`]);
    for (const r of rows) {
      const plain = decryptSecret(r.v);
      // Optimistic: only if the value did not change meanwhile.
      const { rowCount } = await query(`UPDATE ${table} SET ${column} = $2 WHERE ${pk} = $1 AND ${column} = $3`, [r.pk, encryptSecret(plain), r.v]);
      counts[`${table}.${column}`] = (counts[`${table}.${column}`] ?? 0) + (rowCount ?? 0);
    }
  }
  for (const [key, field] of SECRET_SETTINGS) {
    const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
    const v = rows[0]?.value?.[field];
    if (typeof v === 'string' && v && keyIdOf(v) !== active.id) {
      await query('UPDATE settings SET value = jsonb_set(value, $2, to_jsonb($3::text)) WHERE key = $1 AND value->>$4 = $5', [key, `{${field}}`, encryptSecret(decryptSecret(v)), field, v]);
      counts[`settings.${key}.${field}`] = 1;
    }
  }
  if (Object.keys(counts).length) await audit(null, { entity_type: 'keys', entity_ref: active.id, action: 'secrets_reencrypted', changes: { to: active.id, counts } });
  return { active: active.id, reencrypted: counts };
}

/** At start: a change of active key since the last keyed audit entry is itself recorded in the trail (#63). */
export async function recordActiveKey() {
  const active = activeKey();
  if (!active) return; // without a key no keyed entry can be written
  const { rows } = await query("SELECT coalesce(key_id, CASE WHEN hash_version = 2 THEN 'k0' END) AS id FROM audit_log ORDER BY id DESC LIMIT 1");
  if (!rows.length) return;
  const from = rows[0].id as string | null;
  if (from !== active.id) await audit(null, { entity_type: 'keys', entity_ref: active.id, action: 'active_changed', changes: { from, to: active.id } });
}

/** Which keys stored secrets and audit entries use, so an old key is removed only when nothing needs it. */
export async function keyUsage() {
  const used: Record<string, number> = {};
  const add = (id: string | null) => { if (id) used[id] = (used[id] ?? 0) + 1; };
  for (const [table, column] of SECRET_COLUMNS) {
    if (!(await tableExists(table))) continue;
    for (const r of (await query(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)).rows) add(keyIdOf(r.v));
  }
  for (const [key, field] of SECRET_SETTINGS) {
    const { rows } = await query('SELECT value->>$2 AS v FROM settings WHERE key = $1', [key, field]);
    if (rows[0]?.v) add(keyIdOf(rows[0].v));
  }
  const { rows: audit } = await query("SELECT coalesce(key_id, CASE WHEN hash_version = 2 THEN 'k0' END) AS id, count(*)::int AS n FROM audit_log WHERE hash_version >= 2 GROUP BY 1");
  const auditUse = Object.fromEntries(audit.map((r) => [r.id, r.n]));
  return { secrets: used, audit: auditUse };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  rotateSecrets()
    .then((r) => {
      console.log(`Active key: ${r.active}`);
      for (const [where, n] of Object.entries(r.reencrypted)) console.log(`  ${where}: ${n} re-encrypted`);
      if (!Object.keys(r.reencrypted).length) console.log('  Everything already uses the active key.');
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Rotation failed: ${err.message}`);
      process.exit(1);
    });
}
