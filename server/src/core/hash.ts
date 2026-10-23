import { createHash } from 'node:crypto';

// Lookup hashes for random server-generated tokens and content digests. Never pass a user password here:
// passwords go through bcrypt in passwords.ts.

/** SHA-256 digest as raw bytes. */
// codeql[js/insufficient-password-hash] -- inputs are random 256-bit tokens or content, never user passwords (see above)
export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest();

/** SHA-256 digest as lower-case hex. */
// codeql[js/insufficient-password-hash] -- inputs are random 256-bit tokens or content, never user passwords (see above)
export const sha256Hex = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
