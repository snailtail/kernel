// Encryption at rest for stored secrets (AES-256-GCM). Keys come from the environment (keys.ts) and never from the
// database, so a database dump or backup alone does not reveal connector, webhook or provider secrets.
//
//   v2:<key id>:<base64 iv | tag | ciphertext>   current format, names the key (#63)
//   v1:<base64 …>                                 before key ids: the key "k0" (KERNEL_SECRET_KEY), read only
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './errors.js';
import { activeKey, derive, keyById, keyring } from './keys.js';
import { sha256 } from './core/hash.js';

export const secretsConfigured = () => keyring().length > 0;

const seal = (key: Buffer, plain: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
};

const open = (key: Buffer, data: string) => {
  const buf = Buffer.from(data, 'base64');
  // A fixed tag length: otherwise a truncated tag would be accepted, making forgery easier.
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12), { authTagLength: 16 });
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
};

export function encryptSecret(plain: string): string {
  const k = activeKey();
  if (!k) throw new HttpError(503, 'KERNEL_SECRET_KEY is not set; Kernel cannot store secrets until it is configured');
  return `v2:${k.id}:${seal(derive('kernel-secrets', k), plain)}`;
}

export function decryptSecret(stored: string): string {
  if (stored.startsWith('v2:')) {
    const [, id, data] = stored.split(':');
    const k = keyById(id);
    if (!k) throw new Error(`Key ${id} is not configured; cannot decrypt this secret (add it back to KERNEL_SECRET_KEYS)`);
    return open(derive('kernel-secrets', k), data);
  }
  if (stored.startsWith('v1:')) {
    const k = keyById('k0');
    if (!k) throw new Error('KERNEL_SECRET_KEY is not set; cannot decrypt stored secrets');
    return open(sha256(k.raw), stored.slice(3));
  }
  return stored; // legacy plaintext, encrypted on next start (encryptLegacy)
}

export const isEncrypted = (stored: string) => stored.startsWith('v1:') || stored.startsWith('v2:');

/** The key a stored secret uses ('k0' for the old v1 format), or null for plaintext. */
export const keyIdOf = (stored: string) => (stored.startsWith('v2:') ? stored.split(':')[1] : stored.startsWith('v1:') ? 'k0' : null);
