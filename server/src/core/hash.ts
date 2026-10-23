import { createHash } from 'node:crypto';

/** SHA-256 digest as raw bytes. */
export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest();

/** SHA-256 digest as lower-case hex. */
export const sha256Hex = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
