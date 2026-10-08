// Cached MFA policy (roles that must use two-factor authentication), checked on every request.
import { query } from './db.js';

let cache: { roles: string[]; at: number } | null = null;

export async function mfaRequiredFor(role: string) {
  if (!cache || Date.now() - cache.at > 60_000) {
    const { rows } = await query("SELECT value FROM settings WHERE key = 'mfa_required_roles'");
    cache = { roles: rows[0]?.value ?? [], at: Date.now() };
  }
  return cache.roles.includes(role);
}

export const clearMfaPolicyCache = () => {
  cache = null;
};
