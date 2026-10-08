// Password policy after NIST SP 800-63B: length over complexity, no composition rules, and a check against
// common/breached passwords (a built-in list, plus the HIBP k-anonymity API when KERNEL_HIBP_CHECK=true).
import { createHash } from 'node:crypto';
import { badRequest } from './errors.js';
import { outboundFetch } from './outbound.js';

export const MIN_LENGTH = 12;

// The most common passwords and patterns of at least MIN_LENGTH characters (shorter ones fail on length).
const COMMON = new Set(
  `123456789012 1234567890123 qwertyuiopas qwertyuiop123 password1234 password12345 passwordpassword 111111111111
  000000000000 123123123123 iloveyou1234 abcdefghijkl abc123abc123 letmein12345 welcome12345 welcome2024!
  welcome2025! welcome2026! changeme1234 changemenow! administrator admin1234567 adminadmin12 qwerty123456
  1q2w3e4r5t6y zaq12wsxcde3 football1234 baseball1234 superman1234 starwars1234 sommar202020 sommaren2024
  sommaren2025 sommaren2026 vinter2024!! hejhejhejhej losenord1234 lösenord1234 password2024 password2025
  password2026 kernelkernel problemmanagement`.split(/\s+/).filter(Boolean),
);

async function breached(password: string): Promise<boolean> {
  if (process.env.KERNEL_HIBP_CHECK !== 'true') return false;
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  try {
    const res = await outboundFetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' }, timeoutMs: 4000, maxBytes: 2_000_000 });
    if (!res.ok) return false;
    return res.body.split('\n').some((line) => line.startsWith(sha1.slice(5)) && Number(line.split(':')[1]) > 0);
  } catch {
    return false; // fail open: the check is advisory and must not block logins when offline
  }
}

/** Throws 400 with a helpful message if the password is not acceptable. */
export async function checkPassword(password: string, context: { username?: string; display_name?: string } = {}) {
  if (password.length < MIN_LENGTH) throw badRequest(`Use at least ${MIN_LENGTH} characters; a passphrase of a few words works well`);
  if (password.length > 256) throw badRequest('Use at most 256 characters');
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password) || /^(?:0123456789|1234567890|abcdefghij)/.test(lower)) {
    throw badRequest('That password is too common; choose something less guessable');
  }
  for (const part of [context.username, ...(context.display_name ?? '').split(/\s+/)]) {
    if (part && part.length >= 3 && lower.includes(part.toLowerCase())) throw badRequest('The password must not contain your name or username');
  }
  if (await breached(password)) throw badRequest('This password has appeared in a data breach; choose another one');
}
