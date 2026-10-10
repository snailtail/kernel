import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requireReason } from '../audit.js';
import { requireUser } from '../auth.js';
import { query } from '../db.js';
import { requireStepUp } from '../mfa.js';
import { rateLimit } from '../ratelimit.js';
import { clearSensitivePolicyCache, policySchema, scan, sensitivePolicy } from '../sensitive.js';

export async function sensitiveRoutes(app: FastifyInstance) {
  // For the warning while typing or pasting (#61): what the scanner would do with this text. Nothing is stored or
  // logged, and only the kinds of findings come back, never the text.
  app.post('/api/sensitive/check', async (req) => {
    const user = requireUser(req);
    rateLimit(`sensitive-check:${user.id}`, 120, 60_000);
    const { text } = z.object({ text: z.string().max(200_000) }).parse(req.body);
    const policy = await sensitivePolicy();
    const hits = scan(text, { ips: policy.flag_ips });
    const kinds = (c: string) => [...new Set(hits.filter((h) => h.class === c).map((h) => h.type))];
    return { secrets: kinds('secret'), personal: policy.flag_personal ? kinds('personal') : [], action: policy.secrets };
  });

  app.get('/api/admin/sensitive-data', async (req) => {
    requireUser(req, 'security.read');
    return sensitivePolicy();
  });
  app.put('/api/admin/sensitive-data', async (req) => {
    requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = policySchema.extend({ reason: z.string().max(1000).optional() }).parse(req.body);
    const reason = requireReason(body.reason);
    const { reason: _r, ...value } = body;
    const before = await sensitivePolicy();
    await query("INSERT INTO settings (key, value) VALUES ('sensitive_data', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [value]);
    clearSensitivePolicyCache();
    await audit(null, { entity_type: 'setting', entity_ref: 'sensitive_data', action: 'update', changes: { from: before, to: value }, reason });
    return sensitivePolicy();
  });
}
