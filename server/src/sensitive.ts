// The sensitive-data scanner (#61): one set of patterns for everything Kernel takes in – record text, comments,
// events, inbound records, MCP and REST input, text attachments – and for what leaves it for a language model.
//
// Secrets (keys, tokens, passwords, card numbers) are redacted before storage, so they never reach a record's
// history or the audit trail; an administrator can choose to refuse such input instead. Personal data (personal
// identity numbers, email addresses) is often needed, so it is flagged rather than redacted.
//
// Known trade-off: a key=value secret must look like one (quoted, or 6+ characters with a digit or symbol, or a
// connection-string field ending in ";"), so prose is not mangled – and so "password=secret", all letters and not in a
// connection string, is not caught.
//
// Every pattern is linear: bounded quantifiers, character classes that cannot overlap their delimiters, and private
// keys found with indexOf rather than a regex. Text is scanned in chunks, so the cost grows with its length only.
import { z } from 'zod';
import { query } from './db.js';
import { HttpError } from './errors.js';

export type SensitiveClass = 'secret' | 'personal';
export interface Finding { type: string; class: SensitiveClass; start: number; end: number }

interface Detector {
  type: string;
  class: SensitiveClass;
  re: RegExp;
  /** The capture group holding the sensitive part (the rest, like "password=", is kept). Default: the whole match. */
  group?: number;
  /** Extra check on the match, e.g. a checksum, so random numbers do not trigger. */
  valid?: (m: RegExpExecArray) => boolean;
}

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};

/** Swedish personal identity or coordination number: a real date (day + 60 for coordination numbers) and checksum. */
export function validPersonnummer(raw: string) {
  const digits = raw.replace(/[-+]/g, '');
  const ten = digits.length === 12 ? digits.slice(2) : digits;
  if (ten.length !== 10) return false;
  const month = Number(ten.slice(2, 4));
  let day = Number(ten.slice(4, 6));
  if (day > 60) day -= 60;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return luhn(ten);
}

// A value after "password=" or "secret:" must look like a secret, so prose ("password: reset done", "token=expired")
// is left alone: quoted, or at least 6 characters with a digit or symbol, or a connection-string field ("Password=x;").
const credentialValue = (m: RegExpExecArray) => {
  const v = m[3];
  if (/^["']/.test(v)) return true;
  if (v.length >= 6 && /[^A-Za-z]/.test(v)) return true;
  return m[2].includes('=') && m.input[m.index + m[0].length] === ';';
};

const DETECTORS: Detector[] = [
  { type: 'aws-key', class: 'secret', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'aws-secret', class: 'secret', re: /\b(aws_?secret_?access_?key)(\s{0,5}[=:]\s{0,5}["']?)([A-Za-z0-9/+=]{40})/gi, group: 3 },
  { type: 'azure-key', class: 'secret', re: /\b(AccountKey|SharedAccessKey)(=)([A-Za-z0-9+/=]{20,200})/g, group: 3 },
  { type: 'azure-sas', class: 'secret', re: /([?&]sig=)([A-Za-z0-9%+/=]{20,200})/g, group: 2 },
  { type: 'gcp-key', class: 'secret', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'github-token', class: 'secret', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { type: 'slack-token', class: 'secret', re: /\bxox[abprs]-[A-Za-z0-9-]{10,200}/g },
  // codeql[js/regex/missing-regexp-anchor] -- a detector for webhook URLs anywhere in text, not a check of which host a URL points to
  { type: 'slack-webhook', class: 'secret', re: /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]{20,120}/g },
  { type: 'kernel-token', class: 'secret', re: /\bkernel_pat_[A-Za-z0-9_-]{20,100}/g },
  { type: 'jwt', class: 'secret', re: /\beyJ[A-Za-z0-9_-]{10,4000}\.eyJ[A-Za-z0-9_-]{10,8000}\.[A-Za-z0-9_-]{0,4000}/g },
  { type: 'bearer-token', class: 'secret', re: /\b(Bearer)(\s{1,5})([A-Za-z0-9._~+/-]{16,4000}=*)/gi, group: 3 },
  { type: 'ai-key', class: 'secret', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,200}/g },
  { type: 'url-password', class: 'secret', re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,100}:)([^\s@/]{1,200})(@)/gi, group: 2 },
  {
    type: 'password', class: 'secret',
    re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)(\s{0,5}[=:]\s{0,5})("[^"\r\n]{1,200}"|'[^'\r\n]{1,200}'|[^\s;,&"'<>]{4,200})/gi,
    group: 3, valid: credentialValue,
  },
  {
    type: 'card-number', class: 'secret', re: /\b[3-6](?:[ -]?\d){12,18}\b/g,
    valid: (m) => {
      const d = m[0].replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  { type: 'personal-identity-number', class: 'personal', re: /\b(?:19|20)?\d{6}[-+]?\d{4}\b/g, valid: (m) => validPersonnummer(m[0]) },
  { type: 'email', class: 'personal', re: /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}\b/g },
];
const IP: Detector = { type: 'ip-address', class: 'personal', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g };

const CHUNK = 64 * 1024;
const OVERLAP = 4 * 1024;

/** PEM private keys, found without a regex (a lazy match up to END would rescan on every BEGIN). */
function privateKeys(text: string): Finding[] {
  const out: Finding[] = [];
  let from = 0;
  for (;;) {
    const begin = text.indexOf('-----BEGIN ', from);
    if (begin < 0) return out;
    const headEnd = text.indexOf('-----', begin + 11);
    if (headEnd < 0 || headEnd - begin > 60 || !text.slice(begin, headEnd).endsWith('PRIVATE KEY')) {
      from = begin + 11;
      continue;
    }
    const end = text.indexOf('-----END ', headEnd + 5);
    const close = end < 0 ? -1 : text.indexOf('-----', end + 9);
    // An unterminated key is redacted to the end of the text: the secret part follows the header.
    const stop = close < 0 ? text.length : close + 5;
    out.push({ type: 'private-key', class: 'secret', start: begin, end: stop });
    from = stop;
  }
}

export interface ScanOptions { ips?: boolean }

/** Scans all of the text: the work is chunked and linear, so there is no length beyond which text goes unchecked. */
export function scan(text: string, options: ScanOptions = {}): Finding[] {
  const found: Finding[] = privateKeys(text);
  const detectors = options.ips ? [...DETECTORS, IP] : DETECTORS;
  for (let base = 0; base < text.length; base += CHUNK) {
    const chunk = text.slice(base, base + CHUNK + OVERLAP);
    for (const d of detectors) {
      d.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = d.re.exec(chunk))) {
        // Matches starting in the overlap belong to the next chunk.
        if (m.index >= CHUNK && base + CHUNK < text.length) break;
        if (d.valid && !d.valid(m)) continue;
        let start = base + m.index;
        let len = m[0].length;
        if (d.group) {
          start += m[0].indexOf(m[d.group], m.slice(1, d.group).reduce((n, g) => n + (g?.length ?? 0), 0));
          len = m[d.group].length;
        }
        found.push({ type: d.type, class: d.class, start, end: start + len });
      }
    }
  }
  // Overlapping findings (a JWT inside a Bearer header…): keep the first and longest.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Finding[] = [];
  for (const f of found) if (!out.length || f.start >= out[out.length - 1].end) out.push(f);
  return out;
}

/** Replaces findings of the given classes with [REDACTED:type]; returns the text and what was replaced. */
export function redact(text: string, classes: SensitiveClass[] = ['secret'], options: ScanOptions & { except?: string[] } = {}) {
  const hits = scan(text, options).filter((f) => classes.includes(f.class) && !options.except?.includes(f.type));
  if (!hits.length) return { text, types: [] as string[] };
  let out = '';
  let at = 0;
  for (const f of hits) {
    out += text.slice(at, f.start) + `[REDACTED:${f.type}]`;
    at = f.end;
  }
  return { text: out + text.slice(at), types: [...new Set(hits.map((f) => f.type))] };
}

/** Before text goes to a language model (#64): secrets and personal identity numbers. */
export const redactForModel = (text: string) => redact(text, ['secret', 'personal'], { except: ['email'] }).text;

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
export const clearSensitivePolicyCache = () => { cached = null; };

// ---- Inbound text -------------------------------------------------------------------------------------------------

/**
 * Routes whose bodies legitimately carry secrets (sign-in, tokens, credentials Kernel is given to store encrypted) or
 * no free text. Everything else is scanned, so a new route is covered by default; a test keeps this list deliberate.
 */
export const UNSCANNED = [
  /^\/api\/auth\//, /^\/api\/tokens/, /^\/api\/setup/, /^\/api\/users(\/|$)/, /^\/api\/live\//,
  /^\/api\/admin\/(ai\/providers|sso|cf-access)/, /^\/api\/webhooks/, /^\/api\/connectors/, /^\/api\/dev-sources/,
  /^\/api\/event-sources/, /^\/api\/notifications\/settings/, /^\/api\/dev-hooks\//,
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
const MACHINE = [/^\/mcp/, /^\/api\/events$/, /^\/api\/event-hooks\//, /^\/api\/integrations\//, /^\/api\/cis\/upsert/, /^\/api\/cmdb\/ci-batch/, /^\/api\/changes\/register/, /^\/api\/ci-relationships\/sync/];

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

const PERSONAL_TABLES: Record<string, string> = { PRB: 'problems', INC: 'incidents', CHG: 'changes' };

/** Marks a record as holding personal data (for retention, #53, and AI handling, #64). */
export async function markPersonalData(ref: string) {
  const table = PERSONAL_TABLES[ref.toUpperCase().match(/^[A-Z]+/)?.[0] ?? ''];
  if (table) await query(`UPDATE ${table} SET contains_personal_data = true WHERE ref = $1 AND NOT contains_personal_data`, [ref.toUpperCase()]);
}

/** Attachment flags that still matter after redaction: personal data ("redacted:*" only says what was removed). */
export const remainingFlags = (flags: string[]) => flags.filter((f) => !f.startsWith('redacted:'));
