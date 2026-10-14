// Knowledge management (#47): articles people and agents find when they need them. Known errors become articles in
// one step and stay in step with the problem (a database trigger, 117_knowledge.sql); incident resolutions become
// drafts; published articles are suggested while incidents are logged, and "used to resolve" measures their value.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { pool, query, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { logIncident } from './incident-log.js';
import { authorize, can } from './policy.js';
import { logActivity, registerProblemExtra, type Db } from './problems.js';
import { recordUrl, registerRecordType, type RecordType } from './records.js';
import { currentContext } from './context.js';

export const ARTICLE_TYPES = ['how_to', 'troubleshooting', 'known_error', 'faq'] as const;
export const AUDIENCES = ['internal', 'end_users'] as const;
export const ARTICLE_STATUSES = ['draft', 'published', 'retired'] as const;

const fields = {
  title: z.string().trim().min(3).max(200),
  body: z.string().max(100_000),
  article_type: z.enum(ARTICLE_TYPES),
  audience: z.enum(AUDIENCES),
  owner_id: z.number().int().nullable(),
  review_by: z.string().date().nullable(),
};
export const createArticleSchema = z.object({ ...fields, cis: z.array(z.string().max(30)).max(50).optional() }).partial().required({ title: true });
export const updateArticleSchema = z.object(fields).partial().extend({ base: z.object(fields).partial().optional() });
export const transitionArticleSchema = z.object({ to: z.enum(ARTICLE_STATUSES), note: z.string().max(2000).optional() });
export const listArticlesSchema = z.object({
  q: z.string().trim().max(300).optional(),
  status: z.enum([...ARTICLE_STATUSES, 'all']).default('published'),
  article_type: z.enum(ARTICLE_TYPES).optional(),
  audience: z.enum(AUDIENCES).optional(),
  ci: z.string().max(30).optional(),
  due_for_review: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const SELECT = `
  SELECT a.id, a.ref, a.title, a.article_type, a.audience, a.status, a.owner_id, o.display_name AS owner, a.review_by,
         a.synced_with_problem, p.ref AS problem_ref, p.status AS problem_status, i.ref AS source_incident_ref,
         a.helpful, a.not_helpful, a.used_count, a.created_at, a.updated_at, a.published_at, a.retired_at,
         (a.status = 'published' AND a.review_by IS NOT NULL AND a.review_by < current_date) AS due_for_review
  FROM articles a LEFT JOIN users o ON o.id = a.owner_id LEFT JOIN problems p ON p.id = a.problem_id LEFT JOIN incidents i ON i.id = a.source_incident_id`;

const urlOf = (ref: string) => recordUrl(ARTICLE_TYPE, ref);
const withUrl = <T extends { ref: string }>(a: T) => ({ ...a, type: 'article', url: urlOf(a.ref) });

/** Drafts are work in progress: only roles that write articles see them. */
const seesDrafts = (user: User) => can(user.role, 'article.write');

async function nextRef(db: Db) {
  const { rows } = await db.query("SELECT 'KB' || lpad(nextval('article_ref_seq')::text, 6, '0') AS ref");
  return rows[0].ref as string;
}

async function reviewDate(db: Db) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'knowledge'");
  const months = Number(rows[0]?.value?.review_months ?? 12);
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

export async function logArticle(db: Db, articleId: number, userId: number | null, kind: string, body = '', data: object = {}) {
  await db.query('INSERT INTO article_activity (article_id, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6)', [articleId, userId, kind, body, JSON.stringify(data), currentContext().channel]);
}

async function load(db: Db, ref: string, lock = false) {
  const { rows } = await db.query(`SELECT * FROM articles WHERE ref = $1${lock ? ' FOR UPDATE' : ''}`, [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Article ${ref} not found`);
  return rows[0];
}

export async function listArticles(user: User, f: z.infer<typeof listArticlesSchema>) {
  authorize(user, 'article.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.status !== 'all') add('a.status = ?', f.status);
  if (!seesDrafts(user)) where.push("a.status <> 'draft'");
  if (f.article_type) add('a.article_type = ?', f.article_type);
  if (f.audience) add('a.audience = ?', f.audience);
  if (f.ci) add('EXISTS (SELECT 1 FROM article_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.article_id = a.id AND c.ref = ?)', f.ci.toUpperCase());
  if (f.due_for_review) where.push("a.status = 'published' AND a.review_by < current_date");
  let order = 'a.updated_at DESC';
  if (f.q) {
    add("a.search @@ websearch_to_tsquery('simple', ?)", f.q);
    order = `ts_rank(a.search, websearch_to_tsquery('simple', $${params.length})) DESC, a.used_count DESC`;
  }
  params.push(f.limit);
  const { rows } = await query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT $${params.length}`, params);
  return rows.map(withUrl);
}

export async function getArticle(user: User, ref: string) {
  authorize(user, 'article.read');
  const { rows } = await query(`${SELECT.replace('SELECT a.id,', 'SELECT a.id, a.body,')} WHERE a.ref = $1`, [ref.toUpperCase()]);
  const a = rows[0];
  if (!a || (a.status === 'draft' && !seesDrafts(user))) throw notFound(`Article ${ref} not found`);
  const [cis, activity, mine, incidents] = await Promise.all([
    query('SELECT c.ref, c.name, c.class FROM article_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.article_id = $1 ORDER BY c.name', [a.id]),
    query(
      `SELECT x.id, x.kind, x.body, x.data, x.channel, x.created_at, u.display_name AS user_name
       FROM article_activity x LEFT JOIN users u ON u.id = x.user_id WHERE x.article_id = $1 ORDER BY x.created_at DESC, x.id DESC LIMIT 200`,
      [a.id],
    ),
    query('SELECT helpful FROM article_feedback WHERE article_id = $1 AND user_id = $2', [a.id, user.id]),
    query('SELECT i.ref, i.title, x.used_at FROM incident_articles x JOIN incidents i ON i.id = x.incident_id WHERE x.article_id = $1 ORDER BY x.used_at DESC LIMIT 20', [a.id]),
  ]);
  return withUrl({ ...a, cis: cis.rows, activity: activity.rows, my_feedback: mine.rows[0]?.helpful ?? null, used_in: incidents.rows });
}

async function setCis(db: Db, articleId: number, refs: string[]) {
  const { rows } = await db.query('SELECT id, ref FROM configuration_items WHERE ref = ANY($1)', [refs.map((r) => r.toUpperCase())]);
  if (rows.length !== new Set(refs.map((r) => r.toUpperCase())).size) throw badRequest('Every entry in cis must be an existing CI or service ref');
  await db.query('DELETE FROM article_cis WHERE article_id = $1', [articleId]);
  await db.query('INSERT INTO article_cis (article_id, ci_id) SELECT $1, unnest($2::int[])', [articleId, rows.map((r) => r.id)]);
}

export async function createArticle(user: User, input: z.infer<typeof createArticleSchema>, origin: { incidentId?: number } = {}) {
  authorize(user, 'article.write');
  const ref = await tx(async (db) => {
    const ref = await nextRef(db);
    const { rows } = await db.query(
      `INSERT INTO articles (ref, title, body, article_type, audience, owner_id, review_by, source_incident_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [ref, input.title, input.body ?? '', input.article_type ?? 'how_to', input.audience ?? 'internal', input.owner_id ?? user.id, input.review_by ?? null, origin.incidentId ?? null, user.id],
    );
    if (input.cis?.length) await setCis(db, rows[0].id, input.cis);
    await logArticle(db, rows[0].id, user.id, 'created', `${ref} drafted`);
    await audit(db, { entity_type: 'article', entity_ref: ref, action: 'create', changes: { article_type: input.article_type ?? 'how_to', audience: input.audience ?? 'internal' } });
    return ref;
  });
  return getArticle(user, ref);
}

export async function updateArticle(user: User, ref: string, { base, ...input }: z.infer<typeof updateArticleSchema>) {
  authorize(user, 'article.write');
  await tx(async (db) => {
    const cur = await load(db, ref, true);
    if (cur.synced_with_problem && (input.title !== undefined || input.body !== undefined)) {
      throw conflict(`${cur.ref} follows its known error: edit the problem's symptoms, cause or workaround instead`);
    }
    if (cur.synced_with_problem && input.audience === 'end_users') {
      throw conflict(`${cur.ref} follows a known error and stays internal: its cause may hold technical or security details. Write a separate article for end users.`);
    }
    if (cur.status === 'published' && cur.audience !== 'end_users' && input.audience === 'end_users') authorize(user, 'article.publish_public');
    if (base) {
      const stale = Object.keys(base).filter((k) => k in input && JSON.stringify(cur[k] ?? null) !== JSON.stringify((base as any)[k] ?? null));
      if (stale.length) throw conflict(`${stale.join(', ')} changed while you were editing`, { conflicts: stale.map((f) => ({ field: f, current: cur[f] })) });
    }
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && JSON.stringify(cur[k] instanceof Date ? cur[k].toISOString().slice(0, 10) : cur[k]) !== JSON.stringify(v));
    if (!changed.length) return;
    await db.query(`UPDATE articles SET ${changed.map(([k], n) => `${k} = $${n + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [cur.id, ...changed.map(([, v]) => v)]);
    await logArticle(db, cur.id, user.id, 'update', `Updated ${changed.map(([k]) => k.replace('_', ' ')).join(', ')}`, { fields: changed.map(([k]) => k) });
    await audit(db, { entity_type: 'article', entity_ref: cur.ref, action: 'update', changes: Object.fromEntries(changed.map(([k, v]) => [k, { from: cur[k], to: v }])) });
  });
  return getArticle(user, ref);
}

export async function transitionArticle(user: User, ref: string, { to, note }: z.infer<typeof transitionArticleSchema>) {
  authorize(user, 'article.write');
  await tx(async (db) => {
    const a = await load(db, ref, true);
    if (a.status === to) return;
    if (to === 'published') {
      authorize(user, 'article.publish');
      if (a.audience === 'end_users') authorize(user, 'article.publish_public');
      if (!a.body.trim()) throw badRequest('Write the article before publishing it');
    }
    if (to === 'draft' && a.synced_with_problem) throw conflict(`${a.ref} follows its known error and cannot be taken back to draft; retire it instead`);
    const review = to === 'published' ? a.review_by ?? (await reviewDate(db)) : a.review_by;
    await db.query(
      `UPDATE articles SET status = $2, review_by = $3, updated_at = now(),
              published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END,
              retired_at = CASE WHEN $2 = 'retired' THEN now() ELSE NULL END
       WHERE id = $1`,
      [a.id, to, review],
    );
    await logArticle(db, a.id, user.id, 'status', note ?? '', { from: a.status, to });
    await audit(db, { entity_type: 'article', entity_ref: a.ref, action: 'status', changes: { from: a.status, to } });
  });
  return getArticle(user, ref);
}

/** "Publish as article": a known error's workaround as a published internal article that follows the problem. */
export async function publishKnownError(user: User, problemRef: string) {
  authorize(user, 'article.publish');
  const ref = await tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM problems WHERE ref = $1 FOR UPDATE', [problemRef.toUpperCase()]);
    const p = rows[0];
    if (!p) throw notFound(`Problem ${problemRef} not found`);
    if (p.status !== 'known_error') throw badRequest('Only a known error (with its workaround) can be published as an article');
    if (p.classification === 'confidential') throw badRequest(`${p.ref} is confidential, so its text is not published as an article. Write a separate article without the confidential details.`);
    const existing = await db.query('SELECT ref FROM articles WHERE problem_id = $1 AND synced_with_problem AND status <> $2', [p.id, 'retired']);
    if (existing.rows[0]) return existing.rows[0].ref as string;
    const ref = await nextRef(db);
    const { rows: created } = await db.query(
      `INSERT INTO articles (ref, title, body, article_type, audience, status, owner_id, review_by, problem_id, synced_with_problem, created_by, published_at)
       VALUES ($1, $2, (SELECT kernel_known_error_article_body(p) FROM problems p WHERE p.id = $3), 'known_error', 'internal', 'published', $4, $5, $3, true, $4, now())
       RETURNING id`,
      [ref, p.title, p.id, user.id, await reviewDate(db)],
    );
    await db.query('INSERT INTO article_cis (article_id, ci_id) SELECT $1, ci_id FROM problem_cis WHERE problem_id = $2 ON CONFLICT DO NOTHING', [created[0].id, p.id]);
    await logArticle(db, created[0].id, user.id, 'created', `Published from known error ${p.ref}`, { problem: p.ref });
    await logActivity(db, p.id, user.id, 'link', `Published as knowledge article ${ref}`, { kind: 'article', reference: ref, action: 'add' });
    await audit(db, { entity_type: 'article', entity_ref: ref, action: 'create', changes: { from_problem: p.ref, status: 'published' } });
    return ref;
  });
  return getArticle(user, ref);
}

/** "This resolution is reusable": a draft troubleshooting article from a resolved incident. */
export async function draftFromIncident(user: User, incidentRef: string) {
  authorize(user, 'article.write');
  const { rows } = await query('SELECT id, ref, title, description, resolution, restricted, classification FROM incidents WHERE ref = $1', [incidentRef.toUpperCase()]);
  const i = rows[0];
  if (!i) throw notFound(`Incident ${incidentRef} not found`);
  if (i.restricted) throw badRequest('A restricted incident cannot become a knowledge article: articles are read by everyone');
  if (i.classification === 'confidential') throw badRequest('A confidential incident\'s text is not copied into an article: articles are read by everyone. Write a separate article without the confidential details.');
  if (!i.resolution?.trim()) throw badRequest('The incident has no resolution to reuse yet');
  const { rows: cis } = await query('SELECT c.ref FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = $1', [i.id]);
  const body = [i.description && `## Symptoms\n\n${i.description}`, `## Resolution\n\n${i.resolution}`].filter(Boolean).join('\n\n');
  const article = await createArticle(user, { title: i.title, body, article_type: 'troubleshooting', cis: cis.map((c) => c.ref) }, { incidentId: i.id });
  await logIncident(pool, i.id, user.id, 'link', `Drafted knowledge article ${article.ref}`, { kind: 'article', reference: article.ref, action: 'add' });
  return article;
}

export async function articleFeedback(user: User, ref: string, helpful: boolean) {
  authorize(user, 'article.read');
  await tx(async (db) => {
    const a = await load(db, ref, true);
    if (a.status !== 'published') throw badRequest('Feedback is for published articles');
    await db.query(
      `INSERT INTO article_feedback (article_id, user_id, helpful) VALUES ($1, $2, $3)
       ON CONFLICT (article_id, user_id) DO UPDATE SET helpful = excluded.helpful, created_at = now()`,
      [a.id, user.id, helpful],
    );
    await db.query(
      `UPDATE articles SET helpful = (SELECT count(*) FROM article_feedback WHERE article_id = $1 AND helpful),
              not_helpful = (SELECT count(*) FROM article_feedback WHERE article_id = $1 AND NOT helpful) WHERE id = $1`,
      [a.id],
    );
  });
  return getArticle(user, ref);
}

export async function addArticleComment(user: User, ref: string, body: string) {
  authorize(user, 'article.write');
  if (!body.trim()) throw badRequest('Write something');
  await tx(async (db) => {
    const a = await load(db, ref);
    await logArticle(db, a.id, user.id, 'comment', body.trim().slice(0, 20_000));
  });
  return getArticle(user, ref);
}

export async function linkArticleCi(user: User, ref: string, ciRef: string, linked = true) {
  authorize(user, 'article.write');
  await tx(async (db) => {
    const a = await load(db, ref, true);
    const { rows } = await db.query('SELECT id, ref, name FROM configuration_items WHERE ref = $1', [ciRef.toUpperCase()]);
    if (!rows[0]) throw badRequest('Articles link to CIs and services (CI…/SVC… refs)');
    const r = linked
      ? await db.query('INSERT INTO article_cis (article_id, ci_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a.id, rows[0].id])
      : await db.query('DELETE FROM article_cis WHERE article_id = $1 AND ci_id = $2', [a.id, rows[0].id]);
    if (r.rowCount) await logArticle(db, a.id, user.id, 'link', `${linked ? 'Applies to' : 'No longer applies to'} ${rows[0].ref} ${rows[0].name}`, { reference: rows[0].ref, action: linked ? 'add' : 'remove' });
  });
  return getArticle(user, ref);
}

/**
 * Published articles that fit an incident being logged: full-text match on what the user wrote, boosted when the
 * article applies to the same CIs or services (directly or through the services the CIs belong to).
 */
export async function suggestArticles(user: User, text: string, ciRefs: string[] = [], limit = 5) {
  authorize(user, 'article.read');
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (!words.length && !ciRefs.length) return [];
  const { rows } = await query(
    `WITH target AS (
       SELECT c.id FROM configuration_items c WHERE c.ref = ANY($2)
       UNION SELECT r.to_ci FROM ci_relationships r JOIN configuration_items c ON c.id = r.from_ci WHERE c.ref = ANY($2)
     ), q AS (SELECT to_tsquery('simple', $1) AS q)
     SELECT a.ref, a.title, a.article_type, a.audience, a.used_count, a.helpful, a.not_helpful, a.synced_with_problem,
            ts_rank(a.search, q.q) + CASE WHEN EXISTS (SELECT 1 FROM article_cis x WHERE x.article_id = a.id AND x.ci_id IN (SELECT id FROM target)) THEN 0.5 ELSE 0 END AS score
     FROM articles a, q
     WHERE a.status = 'published'
       AND (($1 <> '' AND a.search @@ q.q) OR EXISTS (SELECT 1 FROM article_cis x WHERE x.article_id = a.id AND x.ci_id IN (SELECT id FROM target)))
     ORDER BY score DESC, a.used_count DESC LIMIT $3`,
    [[...new Set(words)].slice(0, 12).map((w) => `${w}:*`).join(' | '), ciRefs.map((r) => r.toUpperCase()), limit],
  );
  return rows.map(withUrl);
}

/** "Used to resolve": the article helped with this incident. */
export async function useArticleForIncident(user: User, incidentRef: string, articleRef: string) {
  authorize(user, 'incident.update');
  authorize(user, 'article.read');
  await tx(async (db) => {
    const { rows } = await db.query('SELECT id, ref FROM incidents WHERE ref = $1 FOR UPDATE', [incidentRef.toUpperCase()]);
    if (!rows[0]) throw notFound(`Incident ${incidentRef} not found`);
    const a = await load(db, articleRef, true);
    if (a.status !== 'published') throw badRequest('Only published articles can be recorded as used');
    const r = await db.query('INSERT INTO incident_articles (incident_id, article_id, used_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [rows[0].id, a.id, user.id]);
    if (!r.rowCount) return;
    await db.query('UPDATE articles SET used_count = used_count + 1 WHERE id = $1', [a.id]);
    await logIncident(db, rows[0].id, user.id, 'link', `Used knowledge article ${a.ref} ${a.title}`, { kind: 'article', reference: a.ref, action: 'add' });
    await logArticle(db, a.id, user.id, 'link', `Used for incident ${rows[0].ref}`, { reference: rows[0].ref });
  });
}

export async function incidentArticles(incidentId: number) {
  const { rows } = await query('SELECT a.ref, a.title, a.status, x.used_at FROM incident_articles x JOIN articles a ON a.id = x.article_id WHERE x.incident_id = $1 ORDER BY x.used_at', [incidentId]);
  return rows;
}

// ---- Record type registration --------------------------------------------------------------------------

const ARTICLE_TYPE: RecordType = {
  type: 'article',
  prefix: 'KB',
  pattern: /^KB\d{6}$/,
  readAction: 'article.read',
  uiPath: (ref) => `/knowledge/${ref}`,
  get: getArticle,
  search: async (user, q, limit) =>
    (await listArticles(user, listArticlesSchema.parse({ q, status: 'all', limit }))).map((a: any) => ({
      type: 'article',
      ref: a.ref,
      title: a.title,
      status: a.status,
      url: a.url,
      summary: [a.article_type.replace('_', ' '), a.audience === 'end_users' ? 'for end users' : 'internal'].join(' · '),
    })),
  rest: {
    list: '/api/articles',
    create: '/api/articles',
    get: '/api/articles/:ref',
    update: '/api/articles/:ref',
    transition: '/api/articles/:ref/transition',
    links: '/api/articles/:ref/links',
    comments: '/api/articles/:ref/comments',
  },
  mcp: { list: 'search_knowledge', get: 'get_article', create: 'create_article', update: 'update_article', transition: 'transition_article' },
};
registerRecordType(ARTICLE_TYPE);

// Problems show the article that publishes their known error.
registerProblemExtra(async (p: { id: number }) => {
  const { rows } = await query("SELECT ref, status FROM articles WHERE problem_id = $1 AND synced_with_problem ORDER BY id DESC LIMIT 1", [p.id]);
  return { knowledge_article: rows[0] ?? null };
});
