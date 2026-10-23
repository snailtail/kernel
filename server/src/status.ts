// Service status and stakeholder communication (#46). Kernel suggests each service's status from what it knows –
// open incidents on the service and its components, maintenance windows, changes being implemented – and a person
// sets it. Updates are written by people; the public page (off by default) shows only what was marked public.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { asSystem } from './context.js';
import { query, tx } from './db.js';
import { badRequest, notFound } from './errors.js';
import { logIncident } from './incident-log.js';
import { notify } from './notifications.js';
import { authorize } from './policy.js';
import { cancelOutside, followers, queueOutside, signUpOpen } from './status-subscriptions.js';
import { cap, esc } from './core/text.js';

export const STATUSES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'] as const;
export const PHASES = ['investigating', 'identified', 'monitoring', 'resolved', 'maintenance'] as const;
type Status = (typeof STATUSES)[number];
const RANK: Record<Status, number> = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 };

/** The suggestion for each service, with the reasons a person can check. */
async function suggestions() {
  const { rows } = await query(
    `WITH svc AS (SELECT id, ref, name FROM configuration_items WHERE class = 'service' AND status <> 'retired'),
     members AS (
       SELECT s.id AS svc_id, s.id AS ci_id FROM svc s
       UNION SELECT r.to_ci, r.from_ci FROM ci_relationships r JOIN svc s ON s.id = r.to_ci WHERE r.type = 'member_of'
     ),
     inc AS (
       SELECT m.svc_id, i.ref, i.priority, i.is_major FROM members m
       JOIN incident_cis x ON x.ci_id = m.ci_id JOIN incidents i ON i.id = x.incident_id
       WHERE i.status NOT IN ('resolved', 'closed')
     ),
     maint AS (
       SELECT m.svc_id FROM members m JOIN maintenance_windows w ON w.ci_id = m.ci_id WHERE now() BETWEEN w.starts_at AND w.ends_at
       UNION SELECT m.svc_id FROM members m JOIN change_cis cc ON cc.ci_id = m.ci_id JOIN changes c ON c.id = cc.change_id WHERE c.status = 'implementing'
     )
     SELECT s.id, s.ref, s.name,
            coalesce(json_agg(DISTINCT jsonb_build_object('ref', inc.ref, 'priority', inc.priority, 'major', inc.is_major)) FILTER (WHERE inc.ref IS NOT NULL), '[]') AS incidents,
            EXISTS (SELECT 1 FROM maint WHERE maint.svc_id = s.id) AS in_maintenance
     FROM svc s LEFT JOIN inc ON inc.svc_id = s.id GROUP BY s.id, s.ref, s.name`,
  );
  return new Map(rows.map((r) => {
    const worst = (r.incidents as { priority: number; major: boolean }[]).reduce<Status>((acc, i) => {
      const s: Status = i.major || i.priority === 1 ? 'major_outage' : i.priority === 2 ? 'partial_outage' : 'degraded';
      return RANK[s] > RANK[acc] ? s : acc;
    }, r.in_maintenance ? 'maintenance' : 'operational');
    return [r.id as number, { suggested: worst, incidents: r.incidents, in_maintenance: r.in_maintenance }];
  }));
}

export async function statusBoard(user: User) {
  authorize(user, 'ci.read');
  const [{ rows: services }, sug, { rows: updates }, { rows: planned }] = await Promise.all([
    query(
      `SELECT c.id, c.ref, c.name, c.criticality, coalesce(s.status, 'operational') AS status, coalesce(s.public, false) AS public, coalesce(s.public_name, '') AS public_name, coalesce(s.public_description, '') AS public_description, coalesce(s.public_status, 'operational') AS public_status,
              s.updated_at, u.display_name AS updated_by,
              EXISTS (SELECT 1 FROM status_follows f WHERE f.user_id = $1 AND f.ci_id = c.id) AS following
       FROM configuration_items c LEFT JOIN service_status s ON s.ci_id = c.id LEFT JOIN users u ON u.id = s.updated_by
       WHERE c.class = 'service' AND c.status <> 'retired' ORDER BY c.criticality, c.name`,
      [user.id],
    ),
    suggestions(),
    query(
      `SELECT su.id, su.phase, su.status, su.message, su.public, su.retracted_at, su.created_at, i.ref AS incident, u.display_name AS author,
              (SELECT array_agg(c.name ORDER BY c.name) FROM configuration_items c WHERE c.id = ANY(su.ci_ids)) AS services,
              (SELECT json_build_object('sent', count(*) FILTER (WHERE d.status = 'sent'), 'pending', count(*) FILTER (WHERE d.status IN ('pending', 'sending')), 'failed', count(*) FILTER (WHERE d.status = 'failed'))
               FROM status_deliveries d WHERE d.update_id = su.id) AS outside
       FROM status_updates su LEFT JOIN incidents i ON i.id = su.incident_id LEFT JOIN users u ON u.id = su.created_by
       ORDER BY su.created_at DESC LIMIT 30`,
    ),
    query(
      `SELECT DISTINCT c.ref, c.title, c.planned_start, c.planned_end, svc.name AS service
       FROM changes c JOIN change_cis cc ON cc.change_id = c.id
       JOIN configuration_items svc ON svc.class = 'service' AND (svc.id = cc.ci_id OR EXISTS (SELECT 1 FROM ci_relationships r WHERE r.type = 'member_of' AND r.from_ci = cc.ci_id AND r.to_ci = svc.id))
       WHERE c.status IN ('scheduled', 'authorize') AND c.planned_start BETWEEN now() AND now() + interval '14 days'
       ORDER BY c.planned_start LIMIT 30`,
    ),
  ]);
  return {
    services: services.map((s) => ({ ...s, ...(sug.get(s.id) ?? { suggested: 'operational', incidents: [], in_maintenance: false }) })),
    updates,
    planned_maintenance: planned,
    settings: { ...(await pageSettings()), sign_up: await signUpOpen() },
  };
}

export const setStatusSchema = z.object({
  status: z.enum(STATUSES),
  /** Also publish this status (requires the service to be public). */
  publish: z.boolean().default(false),
});
export const publicServiceSchema = z.object({
  public: z.boolean(),
  public_name: z.string().trim().max(100).default(''),
  public_description: z.string().trim().max(300).default(''),
});

async function serviceId(db: { query: typeof query }, ref: string) {
  const { rows } = await db.query("SELECT id FROM configuration_items WHERE ref = $1 AND class = 'service'", [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Service ${ref} not found`);
  return rows[0].id as number;
}

export async function setServiceStatus(user: User, ref: string, input: z.infer<typeof setStatusSchema>) {
  authorize(user, 'status.set');
  if (input.publish) authorize(user, 'status.publish');
  await tx(async (db) => {
    const id = await serviceId(db, ref);
    const { rows } = await db.query(
      `INSERT INTO service_status (ci_id, status, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (ci_id) DO UPDATE SET status = $2, updated_by = $3, updated_at = now() RETURNING public`,
      [id, input.status, user.id],
    );
    if (input.publish) {
      if (!rows[0].public) throw badRequest('Make the service public (with a public name) before publishing its status');
      await db.query('UPDATE service_status SET public_status = $2 WHERE ci_id = $1', [id, input.status]);
    }
    await audit(db, { entity_type: 'service_status', entity_ref: ref.toUpperCase(), action: input.publish ? 'publish' : 'update', changes: input });
  });
  return statusBoard(user);
}

/** Whether a service appears on the public page, under which curated name and description. */
export async function setPublicService(user: User, ref: string, input: z.infer<typeof publicServiceSchema>) {
  authorize(user, 'status.publish');
  if (input.public && !input.public_name) throw badRequest('A public service needs a public name (the internal name is never shown)');
  await tx(async (db) => {
    const id = await serviceId(db, ref);
    await db.query(
      `INSERT INTO service_status (ci_id, public, public_name, public_description, updated_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ci_id) DO UPDATE SET public = $2, public_name = $3, public_description = $4, updated_by = $5, updated_at = now()`,
      [id, input.public, input.public_name, input.public_description, user.id],
    );
    await audit(db, { entity_type: 'service_status', entity_ref: ref.toUpperCase(), action: input.public ? 'publish_service' : 'unpublish_service', changes: input });
  });
  return statusBoard(user);
}

/** Takes a published update off the public page and stops mail not yet sent (kept internally, audited). */
export async function retractUpdate(user: User, id: number, reason: string) {
  authorize(user, 'status.publish');
  await tx(async (db) => {
    const { rowCount } = await db.query('UPDATE status_updates SET public = false, retracted_at = now() WHERE id = $1 AND public', [id]);
    if (!rowCount) throw notFound('No published update with that id');
    await cancelOutside(db, id);
    await audit(db, { entity_type: 'status_update', entity_ref: `#${id}`, action: 'retract', reason });
  });
  return { ok: true };
}

export const updateSchema = z.object({
  incident: z.string().max(20).optional(),
  services: z.array(z.string().max(30)).min(1).max(50),
  phase: z.enum(PHASES),
  status: z.enum(STATUSES).optional(),
  message: z.string().trim().min(5).max(2000),
  public: z.boolean().default(false),
});

/** A status update: on the board, on the incident's communication log, to the supporting teams, and (if public) on the page. */
export async function postUpdate(user: User, input: z.infer<typeof updateSchema>) {
  authorize(user, 'status.set');
  if (input.public) authorize(user, 'status.publish');
  await tx(async (db) => {
    const { rows: svcs } = await db.query("SELECT id, ref, name FROM configuration_items WHERE ref = ANY($1) AND class = 'service'", [input.services.map((s) => s.toUpperCase())]);
    if (svcs.length !== new Set(input.services.map((s) => s.toUpperCase())).size) throw badRequest('Every entry in services must be a service ref');
    let incident: { id: number; ref: string } | null = null;
    if (input.incident) {
      const { rows } = await db.query('SELECT id, ref FROM incidents WHERE ref = $1', [input.incident.toUpperCase()]);
      if (!rows[0]) throw notFound(`Incident ${input.incident} not found`);
      incident = rows[0];
    }
    const { rows: created } = await db.query('INSERT INTO status_updates (incident_id, ci_ids, phase, status, message, public, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [
      incident?.id ?? null, svcs.map((s) => s.id), input.phase, input.status ?? null, input.message, input.public, user.id,
    ]);
    if (input.status) {
      for (const s of svcs) {
        await db.query(
          `INSERT INTO service_status (ci_id, status, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (ci_id) DO UPDATE SET status = $2, updated_by = $3, updated_at = now()`,
          [s.id, input.status, user.id],
        );
        // A public update also publishes the status, for services that are public.
        if (input.public) await db.query('UPDATE service_status SET public_status = $2 WHERE ci_id = $1 AND public', [s.id, input.status]);
      }
    }
    // Published: subscribers, organisation contacts and status webhooks hear about it (after the statuses above).
    const outside = input.public ? await queueOutside(db, created[0].id) : null;
    if (incident) await logIncident(db, incident.id, user.id, 'communication', `${input.public ? 'Public status update' : 'Status update'} (${input.phase}): ${input.message}`, { phase: input.phase, status: input.status ?? null, public: input.public, ...(outside ? { outside } : {}) });
    // The teams that support these services hear about it.
    const { rows: members } = await db.query(
      "SELECT DISTINCT m.user_id FROM team_cis tc JOIN team_members m ON m.team_id = tc.team_id WHERE tc.ci_id = ANY($1)",
      [svcs.map((s) => s.id)],
    );
    await notify(db, {
      users: members.map((m) => m.user_id), event: 'watched_update', ref: incident?.ref ?? svcs[0].ref, title: svcs.map((s) => s.name).join(', '),
      summary: `${input.phase[0].toUpperCase()}${input.phase.slice(1)}: ${input.message}`, path: '/service-status', dedupe: `status:${Date.now()}:${svcs[0].ref}`, actorId: user.id,
    });
    // People who follow these services, by their own channels (once, if they are also in a supporting team).
    await notify(db, {
      users: await followers(db, svcs.map((s) => s.id), members.map((m) => m.user_id)), event: 'service_status', ref: incident?.ref ?? svcs[0].ref, title: svcs.map((s) => s.name).join(', '),
      summary: `${input.phase[0].toUpperCase()}${input.phase.slice(1)}: ${input.message}`, path: '/service-status', dedupe: `status-follow:${created[0].id}`, actorId: user.id,
    });
    await audit(db, { entity_type: 'status_update', entity_ref: incident?.ref ?? svcs.map((s) => s.ref).join(','), action: 'create', changes: { phase: input.phase, status: input.status ?? null, public: input.public, services: svcs.map((s) => s.ref) } });
  });
  return statusBoard(user);
}

// ---- The public page ---------------------------------------------------------------------------------------------

export async function pageSettings() {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'status_page'");
  return { public_enabled: false, title: 'Service status', ...(rows[0]?.value ?? {}) } as { public_enabled: boolean; title: string };
}

export async function savePageSettings(user: User, input: { public_enabled: boolean; title: string }, reason: string) {
  authorize(user, 'status.publish');
  await query("INSERT INTO settings (key, value) VALUES ('status_page', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(input)]);
  await audit(null, { entity_type: 'setting', entity_ref: 'status_page', action: 'update', changes: input, reason });
  return input;
}

/** Only what people chose to publish: public services under their public names, public updates, no incident details. */
export async function publicStatus() {
  return asSystem(async () => {
    const s = await pageSettings();
    if (!s.public_enabled) return null;
    const [{ rows: services }, { rows: updates }] = await Promise.all([
      // Published data only: the curated name, description and published status. Never the CI, incidents or alerts.
      query(`SELECT public_name AS name, public_description AS description, public_status AS status FROM service_status WHERE public ORDER BY public_name`),
      query(
        `SELECT su.phase, su.status, su.message, su.created_at,
                (SELECT array_agg(st.public_name ORDER BY st.public_name) FROM service_status st WHERE st.public AND st.ci_id = ANY(su.ci_ids)) AS services
         FROM status_updates su WHERE su.public AND su.created_at > now() - interval '14 days' ORDER BY su.created_at DESC LIMIT 30`,
      ),
    ]);
    // No generation timestamp: the ETag then changes only when something published changes.
    return { title: s.title, services, updates: updates.filter((u) => u.services?.length), sign_up: await signUpOpen() };
  });
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1f27;background:#f6f7f9}h1{font-size:1.5rem}h2{font-size:1.15rem}
.banner{padding:1rem;border-radius:8px;font-weight:600;margin:1rem 0}.s-operational{background:#e7f6ee;color:#1b7f4b}.s-maintenance{background:#e6eeff;color:#1d4ed8}
.s-degraded{background:#fff3e0;color:#b45309}.s-partial_outage{background:#fde7d9;color:#c2410c}.s-major_outage{background:#fdecec;color:#c62828}
ul{list-style:none;padding:0;background:#fff;border:1px solid #e3e6eb;border-radius:8px}li{display:flex;justify-content:space-between;gap:1rem;padding:.75rem 1rem;border-bottom:1px solid #e3e6eb}li:last-child{border-bottom:0}
.tag{font-size:.85rem;padding:.1rem .5rem;border-radius:999px;white-space:nowrap;align-self:center}.u{background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:.75rem 1rem;margin:.5rem 0}.m{color:#5b6473;font-size:.85rem}
form{display:grid;gap:.75rem}fieldset{border:1px solid #e3e6eb;border-radius:8px;display:flex;flex-wrap:wrap;gap:.5rem 1.25rem}input[type=email]{font:inherit;padding:.5rem;border:1px solid #c9ced6;border-radius:6px;width:100%;box-sizing:border-box;max-width:24rem}
button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:0;background:#1d4ed8;color:#fff;justify-self:start;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#0f1218;color:#e6e8ec}ul,.u{background:#171b23;border-color:#2a303b}li,fieldset{border-color:#2a303b}.m{color:#9aa3b2}input[type=email]{background:#171b23;color:inherit;border-color:#2a303b}button{background:#3b6ef5}}`;

/** A one-message page for people outside (sign-up, confirmation, unsubscribe): no scripts, every value escaped. */
export function outsidePage(text: string, form = '') {
  // nosemgrep: raw-html-format -- text is escaped here; form is built by the caller from escaped values
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Service status</title><style>${STYLE}</style></head><body><p>${esc(text)}</p>${form}</body></html>`;
}

export const STATUS_LABEL: Record<string, string> = { operational: 'Operational', degraded: 'Degraded performance', partial_outage: 'Partial outage', major_outage: 'Major outage', maintenance: 'Maintenance' };

/** The public page as plain HTML: no scripts, no external resources, every value escaped. */
export function publicStatusHtml(p: NonNullable<Awaited<ReturnType<typeof publicStatus>>>) {
  const worst = p.services.reduce((acc: string, s: any) => (RANK[s.status as Status] > RANK[acc as Status] ? s.status : acc), 'operational');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(p.title)}</title>
<style>${STYLE}</style></head><body>
<h1>${esc(p.title)}</h1>
<div class="banner s-${esc(worst)}">${worst === 'operational' ? 'All services are operating normally' : esc(STATUS_LABEL[worst])}</div>
<ul>${p.services.map((s: any) => `<li><span>${esc(s.name)}${s.description ? `<br><span class="m">${esc(s.description)}</span>` : ''}</span><span class="tag s-${esc(s.status)}">${esc(STATUS_LABEL[s.status] ?? s.status)}</span></li>`).join('')}</ul>
${p.updates.length ? `<h2>Updates</h2>${p.updates.map((u: any) => `<div class="u"><strong>${esc(cap(u.phase))}</strong> · ${esc((u.services ?? []).join(', '))}<p>${esc(u.message)}</p><div class="m">${esc(new Date(u.created_at).toUTCString())}</div></div>`).join('')}` : ''}
${p.sign_up && p.services.length ? `<h2>Get updates by email</h2><form method="post" action="/status/subscribe">
<input type="email" name="email" required maxlength="254" autocomplete="email" placeholder="you@example.com" aria-label="Email address">
<fieldset><legend class="m">Services (choose none for all)</legend>${p.services.map((s: any) => `<label><input type="checkbox" name="service" value="${esc(s.name)}"> ${esc(s.name)}</label>`).join('')}</fieldset>
<button type="submit">Subscribe</button><p class="m">We send a link to confirm the address first. Every message has a link to unsubscribe.</p></form>` : ''}
</body></html>`;
}
