// Shared data minimisation for everything that leaves Kernel's database (webhooks, logs).

/**
 * Webhooks and logs carry ref, title, status and a link plus short field changes, never long texts such as descriptions,
 * root causes or work notes (they may contain sensitive data; receivers can fetch details through the API).
 */
export function minimiseData(data: unknown): Record<string, unknown> {
  const short = (v: unknown) => v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((data ?? {}) as Record<string, unknown>)) {
    if (short(v)) out[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if ('from' in o || 'to' in o) out[k] = short(o.from) && short(o.to) ? { from: o.from, to: o.to } : { changed: true };
      else if (Object.values(o).every(short)) out[k] = o;
      else out[k] = { changed: true };
    } else if (Array.isArray(v) && v.every(short) && v.length <= 20) out[k] = v;
  }
  return out;
}
