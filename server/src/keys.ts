// The keyring (#63). Every key has an id, so data protected by one key says which, and keys can be rotated: new data
// uses the active key, old data stays readable with the key it names, and rotate-keys re-encrypts stored secrets.
//
//   KERNEL_SECRET_KEY=…                      a single key, id "k0" (as before)
//   KERNEL_SECRET_KEYS=k1:…,k2:…             more keys, as id:secret pairs
//   KERNEL_SECRET_KEY_ID=k2                  the active key (default: the last of KERNEL_SECRET_KEYS, else k0)
//
// Never remove a key while the audit trail has entries made with it (see the security status), or those entries can
// no longer be verified.
import { hkdfSync } from 'node:crypto';

export interface Key { id: string; raw: string }

export function keyring(): Key[] {
  const keys: Key[] = [];
  if (process.env.KERNEL_SECRET_KEY) keys.push({ id: 'k0', raw: process.env.KERNEL_SECRET_KEY });
  // Errors name the position of an entry, never anything from it: they end up in logs, and these variables hold keys.
  const pairs = (process.env.KERNEL_SECRET_KEYS ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  pairs.forEach((pair, n) => {
    const at = pair.indexOf(':');
    if (at < 1) throw new Error('KERNEL_SECRET_KEYS must be id:secret pairs separated by commas');
    const id = pair.slice(0, at);
    if (!/^[a-z0-9_-]{1,20}$/i.test(id)) throw new Error(`Entry ${n + 1} in KERNEL_SECRET_KEYS: the key id must be 1-20 letters, digits, - or _`);
    if (keys.some((k) => k.id === id)) throw new Error(`Entry ${n + 1} in KERNEL_SECRET_KEYS: that key id is already configured`);
    keys.push({ id, raw: pair.slice(at + 1) });
  });
  keys.forEach((k, n) => {
    if (k.raw.length < 32) throw new Error(`${n === 0 && process.env.KERNEL_SECRET_KEY ? 'KERNEL_SECRET_KEY' : 'A key in KERNEL_SECRET_KEYS'} must be at least 32 characters`);
  });
  return keys;
}

export function activeKey(): Key | null {
  const keys = keyring();
  if (!keys.length) return null;
  const wanted = process.env.KERNEL_SECRET_KEY_ID;
  if (wanted) {
    const k = keys.find((x) => x.id === wanted);
    if (!k) throw new Error('KERNEL_SECRET_KEY_ID names a key that is not in KERNEL_SECRET_KEY or KERNEL_SECRET_KEYS');
    return k;
  }
  return keys[keys.length - 1];
}

export const keyById = (id: string) => keyring().find((k) => k.id === id) ?? null;

/** A 256-bit key for one purpose (encryption, the audit chain, digests…) via HKDF, so one secret never serves two uses. */
export const derive = (purpose: string, k: Key) => Buffer.from(hkdfSync('sha256', k.raw, 'kernel', purpose, 32));
