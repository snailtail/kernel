// The sensitive-data policy (#61): what to do with secrets and personal data found by the scanner (scanner.ts), the
// check on inbound text, and personal-data flags on records.
import { z } from 'zod';
import { audit } from './audit.js';
import { query } from './db.js';
import { HttpError } from './errors.js';
import { textKindOfRef } from './records.js';
import { redact, scan } from './scanner.js';

// ---- Policy --------------------------------------------------------------------------------------------------------

export const policySchema = z.object({
  /** redact: store "[REDACTED:type]" and say so; block: refuse the input with what was found. */
  secrets: z.enum(['redact', 'block']).default('redact'),
  /** Flag records whose text holds personal data (personal identity numbers, email addresses). */
  flag_personal: z.boolean().default(true),
  /** Count IP addresses as personal data too (off: they are everyday operational data). */
  flag_ips: z.boolean().default(false),
});
export type SensitivePolicy = z.infer<typeof policySchema>;

let cached: { at: number; value: SensitivePolicy } | null = null;
export async function sensitivePolicy(): Promise<SensitivePolicy> {
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const { rows } = await query("SELECT value FROM settings WHERE key = 'sensitive_data'");
  cached = { at: Date.now(), value: policySchema.parse(rows[0]?.value ?? {}) };
  return cached.value;
}
const clearSensitivePolicyCache = () => { cached = null; };

export async function saveSensitivePolicy(value: SensitivePolicy, reason: string) {
  const before = await sensitivePolicy();
  await query("INSERT INTO settings (key, value) VALUES ('sensitive_data', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [value]);
  clearSensitivePolicyCache();
  await audit(null, { entity_type: 'setting', entity_ref: 'sensitive_data', action: 'update', changes: { from: before, to: value }, reason });
  return sensitivePolicy();
}

// ---- Inbound text -------------------------------------------------------------------------------------------------

/**
 * Routes whose bodies legitimately carry secrets (sign-in, tokens, credentials Kernel is given to store encrypted) or
 * no free text. Everything else is scanned, so a new route is covered by default; a test keeps this list deliberate.
 */
export const UNSCANNED = [
  /^\/api\/auth\//, /^\/api\/portal\/auth\//, /^\/api\/tokens/, /^\/api\/setup/, /^\/api\/users(\/|$)/, /^\/api\/live\//,
  /^\/api\/admin\/(ai\/providers|sso|cf-access)/, /^\/api\/webhooks/, /^\/api\/connectors/, /^\/api\/dev-sources/,
  /^\/api\/event-sources/, /^\/api\/notifications\/settings/, /^\/api\/dev-hooks\//, /^\/api\/teams\/\d+\/paging$/,
  // Text for the AI assistant is redacted on its way to the model (redactForModel) and never stored.
  /^\/api\/ai\//,
  // The check behind the typing warning scans the text itself and stores nothing.
  /^\/api\/sensitive\//,
  // Removing text from a record's history names that text; redacting it first would hide what to remove.
  /^\/api\/records\/[^/]+\/redact$/,
  // Attachments are scanned as files (attachments.ts).
  /^\/api\/records\/[^/]+\/attachments/,
];
/** Machine ingestion: never refused (an alert must not be lost), always redacted. */
const MACHINE = [/^\/mcp/, /^\/api\/events$/, /^\/api\/event-hooks\//, /^\/api\/paging\/\d+\/inbound/, /^\/api\/integrations\//, /^\/api\/cis\/upsert/, /^\/api\/cmdb\/ci-batch/, /^\/api\/changes\/register/, /^\/api\/ci-relationships\/sync/, /^\/api\/candidates\/report$/];

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Redacts secrets in every string of a JSON value (objects are rebuilt, never written to by key); collects what was found. */
function walk(value: unknown, policy: SensitivePolicy, seen: { secrets: Set<string>; personal: Set<string> }, depth = 0): unknown {
  if (depth > 32) return value;
  if (typeof value === 'string') {
    if (value.length < 8) return value;
    const hits = scan(value, { ips: policy.flag_ips });
    if (!hits.length) return value;
    for (const h of hits) (h.class === 'secret' ? seen.secrets : seen.personal).add(h.type);
    return hits.some((h) => h.class === 'secret') ? redact(value, ['secret']).text : value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = walk(value[i], policy, seen, depth + 1);
    return value;
  }
  if (value && typeof value === 'object') {
    // A new object from entries: keys from a request body become own data properties and can never reach a prototype;
    // __proto__, constructor and prototype are dropped altogether.
    return Object.fromEntries(Object.entries(value).filter(([k]) => !UNSAFE_KEYS.has(k)).map(([k, v]) => [k, walk(v, policy, seen, depth + 1)]));
  }
  return value;
}

export interface InboundResult { secrets: string[]; personal: string[]; body: unknown }

/** Scans a request body: secrets redacted (or refused, by policy, for people); personal data reported. */
export async function scanInbound(path: string, body: unknown): Promise<InboundResult | null> {
  if (!body || typeof body !== 'object' || UNSCANNED.some((r) => r.test(path))) return null;
  const policy = await sensitivePolicy();
  const seen = { secrets: new Set<string>(), personal: new Set<string>() };
  // Scan a copy first in block mode, so a refused request changes nothing.
  const block = policy.secrets === 'block' && !MACHINE.some((r) => r.test(path));
  const target = block ? structuredClone(body) : body;
  const out = walk(target, policy, seen);
  if (block && seen.secrets.size) {
    throw new HttpError(422, `This looks like it contains secrets (${[...seen.secrets].join(', ')}). Remove them and try again; Kernel does not store passwords, keys or tokens in records.`, { sensitive: [...seen.secrets] });
  }
  return { secrets: [...seen.secrets], personal: policy.flag_personal ? [...seen.personal] : [], body: out };
}

/** Marks a record as holding personal data (for retention, #53, and AI handling, #64). */
export async function markPersonalData(ref: string) {
  const table = textKindOfRef(ref)?.table;
  if (table) await query(`UPDATE ${table} SET contains_personal_data = true WHERE ref = $1 AND NOT contains_personal_data`, [ref.toUpperCase()]);
}

/** Attachment flags that still matter after redaction: personal data ("redacted:*" only says what was removed). */
export const remainingFlags = (flags: string[]) => flags.filter((f) => !f.startsWith('redacted:'));
