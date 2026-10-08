// Small in-memory fixed-window rate limiter (per process). Used for endpoints that anonymous or untrusted callers
// can hit. With several replicas each enforces its own limit, which still bounds abuse.
import { HttpError } from './errors.js';

const windows = new Map<string, { count: number; resetAt: number }>();

/** Counts a hit for `key`; throws 429 when more than `limit` hits occur within `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
  } else if (++w.count > limit) {
    throw new HttpError(429, 'Too many requests, try again later', { retry_after_seconds: Math.ceil((w.resetAt - now) / 1000) });
  }
  if (windows.size > 50_000) for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
}
