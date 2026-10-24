// TOTP (RFC 6238, SHA-1, 6 digits, 30 s) for two-factor authentication, compatible with common authenticator apps.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(20));

export function codeAt(secret: string, counter: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  const bin = ((h[offset] & 127) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export const counterNow = (now = Date.now()) => Math.floor(now / 30_000);

/**
 * Returns the matching time step (allowing one step of clock drift), or null. Callers reject steps at or before
 * the last accepted one, so a code cannot be replayed.
 */
export function verifyCode(secret: string, code: string, now = Date.now()): number | null {
  const given = Buffer.from(code.replace(/\s/g, ''));
  if (given.length !== 6) return null;
  const c = counterNow(now);
  for (const step of [c - 1, c, c + 1]) {
    if (timingSafeEqual(Buffer.from(codeAt(secret, step)), given)) return step;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string, issuer = 'Kernel') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
