// Encryption at rest for stored secrets (AES-256-GCM). The key comes from KERNEL_SECRET_KEY and never from the
// database, so a database dump or backup alone does not reveal webhook (and later connector) secrets.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors.js';

const PREFIX = 'v1:';

function key(): Buffer | null {
  const raw = process.env.KERNEL_SECRET_KEY;
  if (!raw) return null;
  if (raw.length < 32) throw new Error('KERNEL_SECRET_KEY must be at least 32 characters');
  // Accept any long random string (e.g. `openssl rand -base64 32`) and derive a 256-bit key from it.
  return createHash('sha256').update(raw).digest();
}

export const secretsConfigured = () => !!process.env.KERNEL_SECRET_KEY;

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) throw new HttpError(503, 'KERNEL_SECRET_KEY is not set; Kernel cannot store secrets until it is configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext, encrypted on next start (encryptLegacy)
  const k = key();
  if (!k) throw new Error('KERNEL_SECRET_KEY is not set; cannot decrypt stored secrets');
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export const isEncrypted = (stored: string) => stored.startsWith(PREFIX);
