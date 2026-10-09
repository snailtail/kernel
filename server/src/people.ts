// People, organisations and affected users (#39). A person is a contact – a caller, an affected user, a service
// owner – and needs no login. Histories refer to people by id ("caller → person #12"), never by name, so erasing a
// person anonymises one row and every history and the audit trail stay intact (ADR 0001).
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { query, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { logIncident } from './incident-log.js';
import { authorize, can } from './policy.js';
import { registerProblemExtra, type Db } from './problems.js';

const optionalText = (max: number) => z.string().trim().max(max);
export const personFields = {
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(200).email().nullable(),
  phone: optionalText(50),
  title: optionalText(100),
  department: optionalText(100),
  location: optionalText(100),
  organisation_id: z.number().int().nullable(),
  manager_id: z.number().int().nullable(),
  is_vip: z.boolean(),
  active: z.boolean(),
  external_id: z.string().trim().max(300).nullable(),
};
export const createPersonSchema = z.object(personFields).partial().required({ name: true });
export const updatePersonSchema = z.object(personFields).partial();
export const listPeopleSchema = z.object({
  q: z.string().trim().max(200).optional(),
  organisation_id: z.coerce.number().int().optional(),
  vip: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const SELECT_PERSON = `
  SELECT p.id, p.name, p.email, p.phone, p.title, p.department, p.location, p.organisation_id, o.name AS organisation,
         p.manager_id, m.name AS manager, p.is_vip, p.active, p.external_id, p.source, p.user_id, p.erased_at, p.created_at, p.updated_at
  FROM people p LEFT JOIN organisations o ON o.id = p.organisation_id LEFT JOIN people m ON m.id = p.manager_id`;

/**
 * Data minimisation (#39): everyone who reads incidents may see who a person is (name, organisation, department,
 * VIP); only roles that work incidents see how to reach them (email, phone, manager).
 */
export function withoutContact<T extends Record<string, any>>(p: T): T {
  const { email, phone, manager_id, manager, ...rest } = p;
  return rest as T;
}
export const contactFor = (user: User) => <T extends Record<string, any>>(p: T): T => (can(user.role, 'person.contact') ? p : withoutContact(p));

/** Audit keys for people: "person_name" and the other personal fields are digested by the audit trail. */
const auditable = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k === 'name' ? 'person_name' : k, v]));

export async function listPeople(user: User, f: z.infer<typeof listPeopleSchema>) {
  authorize(user, 'person.read');
  const where = ['p.erased_at IS NULL'];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.organisation_id) add('p.organisation_id = ?', f.organisation_id);
  if (f.vip) where.push('p.is_vip');
  if (f.q) add("(p.name ILIKE '%' || ? || '%' OR p.email ILIKE '%' || ? || '%' OR p.department ILIKE '%' || ? || '%')", f.q.replace(/[\\%_]/g, (m) => '\\' + m));
  params.push(f.limit);
  const { rows } = await query(`${SELECT_PERSON} WHERE ${where.join(' AND ')} ORDER BY p.is_vip DESC, lower(p.name) LIMIT $${params.length}`, params);
  return rows.map(contactFor(user));
}

export async function getPerson(user: User, id: number) {
  authorize(user, 'person.read');
  const { rows } = await query(`${SELECT_PERSON} WHERE p.id = $1`, [id]);
  const p = rows[0];
  if (!p) throw notFound('Person not found');
  const [incidents, services, owned] = await Promise.all([
    query(
      `SELECT i.ref, i.title, i.status, i.priority, i.created_at, CASE WHEN i.caller_id = $1 THEN 'caller' ELSE 'affected' END AS role
       FROM incidents i WHERE i.caller_id = $1 OR EXISTS (SELECT 1 FROM incident_people x WHERE x.incident_id = i.id AND x.person_id = $1)
       ORDER BY i.status IN ('resolved', 'closed'), i.created_at DESC LIMIT 50`,
      [id],
    ),
    query(
      `SELECT c.ref, c.name, c.criticality FROM organisation_services s JOIN configuration_items c ON c.id = s.ci_id
       WHERE s.organisation_id = $1 ORDER BY c.criticality, c.name`,
      [p.organisation_id ?? 0],
    ),
    query(
      `SELECT ref, name, class, CASE WHEN business_owner_id = $1 THEN 'business owner' ELSE 'technical contact' END AS role
       FROM configuration_items WHERE business_owner_id = $1 OR technical_contact_id = $1 ORDER BY name`,
      [id],
    ),
  ]);
  return { ...contactFor(user)(p), incidents: incidents.rows, services: services.rows, owns: owned.rows };
}

async function validate(db: Db, input: { organisation_id?: number | null; manager_id?: number | null }, self?: number) {
  if (input.organisation_id) {
    const { rows } = await db.query('SELECT 1 FROM organisations WHERE id = $1', [input.organisation_id]);
    if (!rows[0]) throw badRequest('Unknown organisation');
  }
  if (input.manager_id) {
    if (input.manager_id === self) throw badRequest('A person cannot be their own manager');
    const { rows } = await db.query('SELECT 1 FROM people WHERE id = $1 AND erased_at IS NULL', [input.manager_id]);
    if (!rows[0]) throw badRequest('Unknown manager');
  }
}

export async function createPerson(user: User, input: z.infer<typeof createPersonSchema>) {
  authorize(user, 'person.write');
  try {
    return await tx(async (db) => {
      await validate(db, input);
      const cols = Object.keys(input).filter((k) => (input as any)[k] !== undefined);
      const { rows } = await db.query(`INSERT INTO people (${cols.join(', ')}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(', ')}) RETURNING id`, cols.map((k) => (input as any)[k]));
      await audit(db, { entity_type: 'person', entity_ref: `#${rows[0].id}`, action: 'create', changes: auditable(input) });
      return rows[0].id as number;
    }).then((id) => getPerson(user, id));
  } catch (err: any) {
    if (err.code === '23505') throw conflict('A person with that email already exists');
    throw err;
  }
}

export async function updatePerson(user: User, id: number, input: z.infer<typeof updatePersonSchema>) {
  authorize(user, 'person.write');
  if (input.is_vip !== undefined) authorize(user, 'organisation.manage');
  try {
    await tx(async (db) => {
      const { rows } = await db.query('SELECT * FROM people WHERE id = $1 AND erased_at IS NULL FOR UPDATE', [id]);
      const cur = rows[0];
      if (!cur) throw notFound('Person not found');
      await validate(db, input, id);
      const changed = Object.entries(input).filter(([k, v]) => v !== undefined && cur[k] !== v);
      if (!changed.length) return;
      await db.query(`UPDATE people SET ${changed.map(([k], n) => `${k} = $${n + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...changed.map(([, v]) => v)]);
      await audit(db, { entity_type: 'person', entity_ref: `#${id}`, action: 'update', changes: auditable(Object.fromEntries(changed.map(([k, v]) => [k, { from: cur[k], to: v }]))) });
    });
  } catch (err: any) {
    if (err.code === '23505') throw conflict('A person with that email already exists');
    throw err;
  }
  return getPerson(user, id);
}

/** Erasure: the contact is anonymised; incidents keep the reference ("Erased person #12"). */
export async function erasePerson(user: User, id: number, reason: string) {
  authorize(user, 'user.manage');
  await tx(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE people SET name = 'Erased person #' || id, email = NULL, phone = '', title = '', department = '', location = '', external_id = NULL,
              manager_id = NULL, is_vip = false, active = false, erased_at = now(), updated_at = now() WHERE id = $1 AND erased_at IS NULL`,
      [id],
    );
    if (!rowCount) throw notFound('No such person, or already erased');
    await db.query('UPDATE people SET manager_id = NULL WHERE manager_id = $1', [id]);
    await audit(db, { entity_type: 'person', entity_ref: `#${id}`, action: 'erase', reason });
  });
  return { ok: true };
}

// ---- Organisations -----------------------------------------------------------------------------

export const organisationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['internal', 'customer']).default('internal'),
  description: z.string().max(2000).default(''),
  active: z.boolean().default(true),
  services: z.array(z.string().max(30)).max(200).optional(),
});

export async function listOrganisations(user: User) {
  authorize(user, 'person.read');
  const { rows } = await query(
    `SELECT o.*, (SELECT count(*)::int FROM people p WHERE p.organisation_id = o.id AND p.erased_at IS NULL) AS people,
            coalesce((SELECT json_agg(json_build_object('ref', c.ref, 'name', c.name) ORDER BY c.name) FROM organisation_services s JOIN configuration_items c ON c.id = s.ci_id WHERE s.organisation_id = o.id), '[]') AS services
     FROM organisations o ORDER BY o.active DESC, lower(o.name)`,
  );
  return rows;
}

export async function saveOrganisation(user: User, id: number | null, input: z.infer<typeof organisationSchema>) {
  authorize(user, 'organisation.manage');
  try {
    const orgId = await tx(async (db) => {
      const { rows } = id
        ? await db.query('UPDATE organisations SET name = $2, kind = $3, description = $4, active = $5 WHERE id = $1 RETURNING id', [id, input.name, input.kind, input.description, input.active])
        : await db.query('INSERT INTO organisations (name, kind, description, active) VALUES ($1, $2, $3, $4) RETURNING id', [input.name, input.kind, input.description, input.active]);
      if (!rows[0]) throw notFound('Organisation not found');
      if (input.services) {
        const { rows: svc } = await db.query("SELECT id FROM configuration_items WHERE ref = ANY($1) AND class = 'service'", [input.services.map((r) => r.toUpperCase())]);
        if (svc.length !== new Set(input.services).size) throw badRequest('Every entry in services must be a service ref');
        await db.query('DELETE FROM organisation_services WHERE organisation_id = $1', [rows[0].id]);
        await db.query('INSERT INTO organisation_services (organisation_id, ci_id) SELECT $1, unnest($2::int[])', [rows[0].id, svc.map((s) => s.id)]);
      }
      await audit(db, { entity_type: 'organisation', entity_ref: `#${rows[0].id}`, action: id ? 'update' : 'create', changes: input });
      return rows[0].id as number;
    });
    return (await listOrganisations(user)).find((o) => o.id === orgId);
  } catch (err: any) {
    if (err.code === '23505') throw conflict('An organisation with that name already exists');
    throw err;
  }
}

// ---- Incidents: caller and affected people ------------------------------------------------------

/** Finds a contact by email, or creates one (quick add from the caller field). */
export async function resolvePerson(db: Db, user: User, ref: { id?: number; email?: string; name?: string }, create = true) {
  if (ref.id) {
    const { rows } = await db.query('SELECT id FROM people WHERE id = $1 AND erased_at IS NULL', [ref.id]);
    if (!rows[0]) throw badRequest('Unknown person');
    return rows[0].id as number;
  }
  if (ref.email) {
    const { rows } = await db.query('SELECT id FROM people WHERE lower(email) = lower($1) AND erased_at IS NULL', [ref.email]);
    if (rows[0]) return rows[0].id as number;
  }
  if (!create) throw badRequest('No such contact. Agents can only link existing contacts; ask a person to add new ones.');
  if (!ref.name && !ref.email) throw badRequest('Give a person id, an email or a name');
  authorize(user, 'person.write');
  const { rows } = await db.query('INSERT INTO people (name, email) VALUES ($1, $2) RETURNING id', [ref.name || ref.email, ref.email || null]);
  await audit(db, { entity_type: 'person', entity_ref: `#${rows[0].id}`, action: 'create', changes: auditable({ name: ref.name || ref.email, email: ref.email ?? null }) });
  return rows[0].id as number;
}

export const personRefSchema = z.object({ id: z.number().int().optional(), email: z.string().trim().email().max(200).optional(), name: z.string().trim().max(200).optional() });

export async function setAffected(user: User, incidentRef: string, person: z.infer<typeof personRefSchema>, affected: boolean, create = true) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const { rows } = await db.query('SELECT id, ref FROM incidents WHERE ref = $1 FOR UPDATE', [incidentRef.toUpperCase()]);
    if (!rows[0]) throw notFound(`Incident ${incidentRef} not found`);
    const personId = await resolvePerson(db, user, person, create);
    const { rowCount } = affected
      ? await db.query('INSERT INTO incident_people (incident_id, person_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [rows[0].id, personId, user.id])
      : await db.query('DELETE FROM incident_people WHERE incident_id = $1 AND person_id = $2', [rows[0].id, personId]);
    // Histories name people by id only, so erasure never has to rewrite them.
    if (rowCount) await logIncident(db, rows[0].id, user.id, 'update', `${affected ? 'Added' : 'Removed'} affected person #${personId}`, { affected_person: { id: personId, action: affected ? 'add' : 'remove' } });
  });
}

/**
 * Histories store "person #12"; the current name is filled in when shown, so an erased person shows as
 * "Erased person #12" without the history ever being rewritten.
 */
export async function namePeople<T extends { body: string }>(rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.flatMap((r) => [...r.body.matchAll(/person #(\d+)/g)].map((m) => Number(m[1]))))];
  if (!ids.length) return rows;
  const { rows: found } = await query('SELECT id, name FROM people WHERE id = ANY($1)', [ids]);
  const names = new Map(found.map((p) => [p.id, p.name as string]));
  return rows.map((r) => ({ ...r, body: r.body.replace(/person #(\d+)/g, (m, id) => (names.has(Number(id)) ? `${names.get(Number(id))} (#${id})` : m)) }));
}

/** People on an incident, and whether they should raise the suggested impact (VIP, many affected). */
export async function incidentPeople(incident: { id: number; caller_id: number | null; impact: number }, user: User) {
  const { rows } = await query(
    `SELECT p.id, p.name, p.email, p.is_vip, p.erased_at IS NOT NULL AS erased, o.name AS organisation FROM incident_people x
     JOIN people p ON p.id = x.person_id LEFT JOIN organisations o ON o.id = p.organisation_id WHERE x.incident_id = $1 ORDER BY p.is_vip DESC, p.name`,
    [incident.id],
  );
  const { rows: caller } = incident.caller_id
    ? await query('SELECT p.id, p.name, p.email, p.phone, p.is_vip, o.name AS organisation FROM people p LEFT JOIN organisations o ON o.id = p.organisation_id WHERE p.id = $1', [incident.caller_id])
    : { rows: [] as any[] };
  const { rows: settings } = await query("SELECT value FROM settings WHERE key = 'people_priority'");
  const s = { affected_for_high_impact: 10, vip_raises_impact: true, ...(settings[0]?.value ?? {}) };
  const vip = s.vip_raises_impact && (caller[0]?.is_vip || rows.some((p) => p.is_vip));
  // Suggestions only: people never change the priority by themselves.
  const hint = rows.length >= s.affected_for_high_impact && incident.impact > 1
    ? { suggested_impact: 1, reason: `${rows.length} people are affected: consider impact High.` }
    : vip && incident.impact > 2
      ? { suggested_impact: 2, reason: 'A VIP is involved: consider impact Medium or higher.' }
      : null;
  const shown = contactFor(user);
  return { caller: caller[0] ? shown(caller[0]) : null, affected_people: rows.map(shown), people_hint: hint };
}

// Problems: the organisations affected, rolled up from the people on their incidents.
registerProblemExtra(async (p) => {
  const { rows } = await query(
    `SELECT DISTINCT o.id, o.name FROM incidents i
     JOIN people pe ON pe.id = i.caller_id OR pe.id IN (SELECT person_id FROM incident_people x WHERE x.incident_id = i.id)
     JOIN organisations o ON o.id = pe.organisation_id
     WHERE i.problem_id = $1 ORDER BY o.name`,
    [p.id],
  );
  return { affected_organisations: rows };
});
