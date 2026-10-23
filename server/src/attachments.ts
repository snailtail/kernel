// Attachments on records (#51, #74): screenshots, logs, configuration files, PDFs.
//
// Safety (#56): the type is decided from the bytes, never from the client's name or Content-Type. Images are decoded
// and re-encoded (metadata such as GPS dropped), so the browser never receives the uploaded bytes. Text is stored as
// text and never rendered as HTML: SVG and HTML files are text here. Access follows the record: whoever may see the
// record may see its attachments, and whoever may work on it may attach.
import { maskedRefs } from './confidential.js';
import { currentContext } from './context.js';
import { markPersonalData, redact, remainingFlags, scan, sensitivePolicy } from './sensitive.js';
import sharp from 'sharp';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { type Db, pool, query, tx } from './db.js';
import { badRequest, forbidden, HttpError, notFound } from './errors.js';
import { authorize, type Action } from './policy.js';
import { logActivity } from './activity.js';
import { typeForRef } from './records.js';
import { sha256Hex } from './core/hash.js';

/** What it takes to attach to (or remove from) each record type. Reading follows the record's own access. */
const WRITE: Record<string, Action> = { problem: 'problem.comment', incident: 'incident.update', change: 'change.update', ci: 'ci.annotate', service: 'ci.annotate', article: 'article.write' };

/** Files that are kept but only ever downloaded (zip containers and gzip). */
const DOWNLOAD_ONLY = /\.(docx|xlsx|pptx|odt|ods|odp|zip|gz|tgz|pcap|pcapng)$/i;
const MAX_PIXELS = 40_000_000;

async function settings() {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'attachments'");
  const s = { max_file_mb: 10, max_per_record: 100, max_total_gb: 10, ...(rows[0]?.value ?? {}) } as { max_file_mb: number; max_per_record: number; max_total_gb: number };
  s.max_file_mb = Math.min(s.max_file_mb, 100);
  return s;
}

export const maxUploadBytes = async () => (await settings()).max_file_mb * 1024 * 1024;
/** The most any setting can allow; Fastify never reads more than this. */
export const HARD_LIMIT = 100 * 1024 * 1024;

/** A name that is safe to show and to put in a Content-Disposition header. */
function cleanFilename(name: string) {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
  return cleaned || 'attachment';
}

function isUtf8Text(buf: Buffer) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

type Sniffed = { kind: 'image'; format: 'png' | 'jpeg' | 'gif' | 'webp' } | { kind: 'pdf' } | { kind: 'text' } | { kind: 'file'; contentType: string };

/** Decides the type from the content. Anything not recognised is refused. */
function sniff(buf: Buffer, filename: string): Sniffed {
  const head = (n: number) => buf.subarray(0, n).toString('hex');
  if (head(8) === '89504e470d0a1a0a') return { kind: 'image', format: 'png' };
  if (head(3) === 'ffd8ff') return { kind: 'image', format: 'jpeg' };
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return { kind: 'image', format: 'gif' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { kind: 'image', format: 'webp' };
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf' };
  if (DOWNLOAD_ONLY.test(filename)) {
    if (head(4) === '504b0304') return { kind: 'file', contentType: 'application/zip' };
    if (head(2) === '1f8b') return { kind: 'file', contentType: 'application/gzip' };
    if (/\.pcap(ng)?$/i.test(filename)) return { kind: 'file', contentType: 'application/vnd.tcpdump.pcap' };
  }
  // Logs, configuration, JSON, CSV, Markdown – and SVG/HTML, which are shown as source, never rendered.
  if (isUtf8Text(buf)) return { kind: 'text' };
  throw badRequest('This file type is not accepted. Attach images, PDFs, text files (logs, configuration, CSV, JSON) or Office/zip files.');
}

async function loadRecord(db: Db, user: User, ref: string) {
  const t = typeForRef(ref);
  const record = await t.get(user, ref.toUpperCase()); // enforces read access (and later scoping, #53)
  const { rows } = await db.query(`SELECT id FROM ${t.table} WHERE ref = $1`, [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`${ref} not found`);
  return { type: t.type, ref: ref.toUpperCase(), id: rows[0].id as number, record };
}

const logOn = (db: Db, type: string, id: number, userId: number, body: string, data: object) => logActivity(db, type, id, userId, 'update', body, data);

const SELECT = `SELECT a.id, a.record_type, a.record_ref, a.filename, a.kind, a.content_type, a.size, a.width, a.height, a.flags,
                       a.created_at, a.uploaded_by, u.display_name AS uploaded_by_name
                FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by`;

export async function listAttachments(user: User, ref: string) {
  const r = await loadRecord(pool, user, ref);
  const { rows } = await query(`${SELECT} WHERE a.record_type = $1 AND a.record_ref = $2 ORDER BY a.created_at, a.id`, [r.type, r.ref]);
  return rows;
}

export async function addAttachment(user: User, ref: string, filename: string, data: Buffer) {
  const s = await settings();
  if (!data.length) throw badRequest('The file is empty');
  if (data.length > s.max_file_mb * 1024 * 1024) throw new HttpError(413, `Files may be at most ${s.max_file_mb} MB`);
  const name = cleanFilename(filename);
  const type = sniff(data, name);
  const variants: { variant: 'original' | 'preview' | 'thumb'; contentType: string; data: Buffer }[] = [];
  let width: number | null = null;
  let height: number | null = null;
  let contentType: string;
  let flags: string[] = [];
  let personal: string[] = [];
  if (type.kind === 'image') {
    // Decode and re-encode: metadata (EXIF, GPS, comments) is dropped and malformed payloads never reach a browser.
    const img = () => sharp(data, { limitInputPixels: MAX_PIXELS, animated: type.format === 'gif' || type.format === 'webp' }).rotate();
    let original: Buffer;
    try {
      const meta = await sharp(data, { limitInputPixels: MAX_PIXELS }).metadata();
      width = meta.width ?? null;
      height = meta.pageHeight ?? meta.height ?? null;
      original = type.format === 'jpeg' ? await img().jpeg({ quality: 92 }).toBuffer() : type.format === 'gif' ? await img().gif().toBuffer() : type.format === 'webp' ? await img().webp({ quality: 92 }).toBuffer() : await img().png().toBuffer();
    } catch {
      throw badRequest('The image could not be read');
    }
    contentType = `image/${type.format}`;
    variants.push({ variant: 'original', contentType, data: original });
    variants.push({ variant: 'preview', contentType: 'image/webp', data: await sharp(original).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer() });
    variants.push({ variant: 'thumb', contentType: 'image/webp', data: await sharp(original).resize({ width: 320, height: 240, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer() });
  } else if (type.kind === 'pdf') {
    contentType = 'application/pdf';
    variants.push({ variant: 'original', contentType, data });
  } else if (type.kind === 'text') {
    contentType = 'text/plain; charset=utf-8';
    // Secrets in logs and configuration are redacted before the file is stored (#61); personal data is flagged.
    const text = data.toString('utf8');
    const policy = await sensitivePolicy();
    const hits = scan(text, { ips: policy.flag_ips });
    const secrets = [...new Set(hits.filter((h) => h.class === 'secret').map((h) => h.type))];
    if (secrets.length && policy.secrets === 'block') throw new HttpError(422, `${name} seems to contain secrets (${secrets.join(', ')}). Remove them and attach it again.`, { sensitive: secrets });
    personal = policy.flag_personal ? [...new Set(hits.filter((h) => h.class === 'personal').map((h) => h.type))] : [];
    flags = [...personal, ...secrets.map((t) => `redacted:${t}`)];
    variants.push({ variant: 'original', contentType, data: secrets.length ? Buffer.from(redact(text, ['secret'], { ips: policy.flag_ips }).text, 'utf8') : data });
  } else {
    contentType = type.contentType;
    variants.push({ variant: 'original', contentType, data });
  }
  const stored = variants[0].data;

  const id = await tx(async (db) => {
    const r = await loadRecord(db, user, ref);
    authorize(user, WRITE[r.type]);
    const { rows: count } = await db.query('SELECT count(*)::int AS n FROM attachments WHERE record_type = $1 AND record_ref = $2', [r.type, r.ref]);
    if (count[0].n >= s.max_per_record) throw badRequest(`A record can have at most ${s.max_per_record} attachments`);
    // Attachments live in the database and in every backup, so the installation has a total quota.
    const { rows: total } = await db.query('SELECT coalesce(sum(length(data)), 0)::bigint AS n FROM attachment_blobs');
    if (Number(total[0].n) + stored.length > s.max_total_gb * 1024 ** 3) throw new HttpError(507, 'Attachment storage is full. An administrator can remove attachments or raise the quota.');
    const { rows } = await db.query(
      `INSERT INTO attachments (record_type, record_ref, filename, kind, content_type, size, sha256, width, height, flags, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [r.type, r.ref, name, type.kind, contentType, stored.length, sha256Hex(stored), width, height, flags, user.id],
    );
    for (const v of variants) await db.query('INSERT INTO attachment_blobs (attachment_id, variant, content_type, data) VALUES ($1, $2, $3, $4)', [rows[0].id, v.variant, v.contentType, v.data]);
    if (personal.length) await markPersonalData(r.ref);
    await logOn(db, r.type, r.id, user.id, `Attached ${name}`, { attachment: { id: rows[0].id, kind: type.kind } });
    await audit(db, { entity_type: 'attachment', entity_ref: `#${rows[0].id}`, action: 'create', changes: { record: r.ref, kind: type.kind, size: stored.length, filename: name } });
    return rows[0].id as number;
  });
  return (await query(`${SELECT} WHERE a.id = $1`, [id])).rows[0];
}

async function loadAttachment(user: User, id: number) {
  const { rows } = await query('SELECT * FROM attachments WHERE id = $1', [id]);
  const a = rows[0];
  if (!a) throw notFound('Attachment not found');
  await loadRecord(pool, user, a.record_ref); // the record's read access decides
  // A confidential record's attachments are part of its text (#61): its people, a reveal – and never agents.
  const agent = currentContext().channel === 'mcp';
  if ((await maskedRefs(agent ? null : user, [a.record_ref])).has(a.record_ref)) throw forbidden(`${a.record_ref} is confidential. ${agent ? 'Its attachments are not available to agents.' : 'Reveal its text to open its attachments.'}`);
  return a;
}

export async function getAttachmentData(user: User, id: number, variant: 'original' | 'preview' | 'thumb') {
  const a = await loadAttachment(user, id);
  const v = a.kind === 'image' ? variant : 'original';
  const { rows } = await query('SELECT content_type, data FROM attachment_blobs WHERE attachment_id = $1 AND variant = $2', [id, v]);
  if (!rows[0]) throw notFound('Attachment data not found');
  return { attachment: a, contentType: rows[0].content_type as string, data: rows[0].data as Buffer };
}

/** Text attachments, a page of lines at a time, for the in-place viewer and for agents. */
export async function getAttachmentText(user: User, id: number, from = 0, limit = 2000) {
  const { attachment, data } = await getAttachmentData(user, id, 'original');
  if (attachment.kind !== 'text') throw badRequest('Only text attachments can be read as text');
  const lines = data.toString('utf8').replace(/\r\n?/g, '\n').split('\n');
  const start = Math.max(0, from);
  const firstError = lines.findIndex((l) => /\b(ERROR|FATAL|CRITICAL|Exception|Traceback)\b/.test(l));
  return { id, filename: attachment.filename, flags: attachment.flags, total_lines: lines.length, from: start, lines: lines.slice(start, start + Math.min(limit, 5000)), first_error_line: firstError >= 0 ? firstError : null };
}

export async function deleteAttachment(user: User, id: number) {
  const a = await loadAttachment(user, id);
  const manager = user.role === 'admin' || user.role === 'manager';
  if (a.uploaded_by !== user.id && !manager) throw forbidden('Only the uploader or a manager can remove an attachment');
  authorize(user, WRITE[a.record_type]);
  await tx(async (db) => {
    const r = await loadRecord(db, user, a.record_ref);
    await db.query('DELETE FROM attachments WHERE id = $1', [id]); // the bytes go too (no soft delete: erasure must erase)
    await logOn(db, r.type, r.id, user.id, `Removed attachment ${a.filename}`, { attachment: { id, removed: true } });
    await audit(db, { entity_type: 'attachment', entity_ref: `#${id}`, action: 'delete', changes: { record: a.record_ref } });
  });
  return { ok: true };
}

/** For the security status: how much of the quota attachments use. */
export async function storageUse() {
  const s = await settings();
  const { rows } = await query('SELECT coalesce(sum(length(data)), 0)::bigint AS bytes, count(DISTINCT attachment_id)::int AS files FROM attachment_blobs');
  return { bytes: Number(rows[0].bytes), files: rows[0].files as number, quota_bytes: s.max_total_gb * 1024 ** 3 };
}

// ---- What may go to an AI provider (MCP) -------------------------------------------------------

export interface AiDataPolicy { attachment_images: boolean; flagged_text: boolean; restricted_records?: boolean }

export async function aiDataPolicy(): Promise<AiDataPolicy> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'ai_data'");
  return { attachment_images: false, flagged_text: false, restricted_records: false, ...(rows[0]?.value ?? {}) };
}

export async function setAiDataPolicy(actor: User, policy: AiDataPolicy, reason: string) {
  await query("INSERT INTO settings (key, value) VALUES ('ai_data', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(policy)]);
  await audit(null, { entity_type: 'setting', entity_ref: 'ai_data', action: 'update', changes: { ...policy }, reason });
  void actor;
  return policy;
}

/** An attachment for an AI agent: refused unless the policy allows images, and never flagged text by default. */
export async function attachmentForAgent(user: User, id: number, from: number, limit: number) {
  const policy = await aiDataPolicy();
  const file = await getAttachmentData(user, id, 'preview');
  const a = file.attachment;
  if (a.kind === 'image') {
    if (!policy.attachment_images) throw forbidden(`${a.filename} is an image. Images are not shared with AI agents on this installation (an administrator can allow it under Security status).`);
    return { image: file.data.toString('base64'), mimeType: file.contentType, filename: a.filename, width: a.width, height: a.height };
  }
  if (a.kind !== 'text') throw badRequest(`${a.filename} is a ${a.kind}; only text and images can be read`);
  // Redacted secrets are gone from the file; what remains flagged is personal data.
  const sensitive = remainingFlags(a.flags);
  if (sensitive.length && !policy.flagged_text) throw forbidden(`${a.filename} may contain sensitive data (${sensitive.join(', ')}), so it is not sent to AI agents. A person can read it in Kernel.`);
  return getAttachmentText(user, id, from, limit);
}

