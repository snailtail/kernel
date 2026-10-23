import { createHash } from 'node:crypto';

/** SHA-256 digest of content (a file, a mail, a response body) as raw bytes. */
export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest();

/** SHA-256 digest of content as lower-case hex. */
export const sha256Hex = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');

// Lookup hashes for random server-generated tokens (sessions, API and source tokens, MFA challenges, sign-in and
// approval links, callback and confirmation tokens): 256 bits of randomness, so a fast hash is right. Only those
// go here; passwords go through bcrypt in passwords.ts, and other content uses sha256/sha256Hex above.

/** The stored hash of a random server-generated token, as lower-case hex. */
// codeql[js/insufficient-password-hash] -- only random 256-bit server-generated tokens reach this, never user passwords
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The stored hash of a random server-generated token, as raw bytes. */
// codeql[js/insufficient-password-hash] -- only random 256-bit server-generated tokens reach this, never user passwords
export const tokenHashBytes = (token: string) => createHash('sha256').update(token).digest();
