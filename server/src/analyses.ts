// Structured root cause analysis techniques attached to problems.
import { z } from 'zod';
import type { User } from './auth.js';
import { tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { authorize } from './policy.js';
import { getProblem, loadForUpdate, logActivity } from './problems.js';

export const TECHNIQUES = ['five_whys', 'ishikawa', 'kepner_tregoe', 'timeline'] as const;
export type Technique = (typeof TECHNIQUES)[number];

export const TECHNIQUE_LABEL: Record<Technique, string> = {
  five_whys: '5 Whys',
  ishikawa: 'Ishikawa',
  kepner_tregoe: 'Kepner-Tregoe',
  timeline: 'Timeline',
};

const text = z.string().max(5000).default('');
const isIsNot = z.object({ is: text, is_not: text, distinction: text }).default({ is: '', is_not: '', distinction: '' });

export const DATA_SCHEMAS = {
  five_whys: z.object({
    problem_statement: text,
    whys: z.array(z.object({ why: text, because: text })).max(15).default([]),
  }),
  ishikawa: z.object({
    effect: text,
    categories: z.array(z.object({ name: z.string().max(100), causes: z.array(z.string().max(1000)).max(30).default([]) })).max(10).default([]),
  }),
  kepner_tregoe: z.object({
    problem_statement: text,
    what: isIsNot,
    where: isIsNot,
    when: isIsNot,
    extent: isIsNot,
    changes: text,
    possible_causes: z
      .array(z.object({ cause: text, test: text, result: z.enum(['untested', 'explains', 'does_not_explain']).default('untested') }))
      .max(30)
      .default([]),
  }),
  timeline: z.object({
    events: z
      .array(
        z.object({
          at: z.string().max(40).describe('ISO date-time, e.g. 2026-10-08T14:05'),
          kind: z.enum(['incident', 'change', 'deployment', 'alert', 'observation', 'other']).default('observation'),
          description: text,
          reference: z.string().max(200).default(''),
        }),
      )
      .max(200)
      .default([]),
  }),
} satisfies Record<Technique, z.ZodType>;

/** Starting content for a new analysis, so the editor has the expected structure. */
export function emptyData(technique: Technique): unknown {
  switch (technique) {
    case 'five_whys':
      return { problem_statement: '', whys: [{ why: '', because: '' }] };
    case 'ishikawa':
      return {
        effect: '',
        categories: ['People', 'Process', 'Technology', 'Supplier', 'Environment', 'Measurement'].map((name) => ({ name, causes: [] })),
      };
    case 'kepner_tregoe':
      return DATA_SCHEMAS.kepner_tregoe.parse({});
    case 'timeline':
      return { events: [] };
  }
}

export const createAnalysisSchema = z.object({
  technique: z.enum(TECHNIQUES),
  title: z.string().trim().max(200).optional(),
  data: z.unknown().optional(),
  conclusion: z.string().max(20000).optional(),
});

export const updateAnalysisSchema = z.object({
  title: z.string().trim().max(200).optional(),
  data: z.unknown().optional(),
  conclusion: z.string().max(20000).optional(),
  /** updated_at of the version the edit started from; a newer save by someone else gives 409. */
  base_updated_at: z.string().optional(),
});

function parseData(technique: Technique, data: unknown) {
  const result = DATA_SCHEMAS[technique].safeParse(data);
  if (!result.success) {
    throw badRequest(`Invalid ${TECHNIQUE_LABEL[technique]} data: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data;
}

export async function createAnalysis(user: User, ref: string, input: z.infer<typeof createAnalysisSchema>) {
  authorize(user, 'analysis.write');
  const data = parseData(input.technique, input.data ?? emptyData(input.technique));
  await tx(async (db) => {
    const problem = await loadForUpdate(db, ref);
    if (problem.status === 'closed') throw conflict('Reopen the problem before adding analyses');
    const title = input.title || TECHNIQUE_LABEL[input.technique];
    const { rows } = await db.query(
      `INSERT INTO problem_analyses (problem_id, technique, title, data, conclusion, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
      [problem.id, input.technique, title, JSON.stringify(data), input.conclusion ?? '', user.id],
    );
    await logActivity(db, problem.id, user.id, 'analysis', `Started ${TECHNIQUE_LABEL[input.technique]} analysis`, { analysis_id: rows[0].id });
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [problem.id]);
  });
  return getProblem(ref);
}

export async function updateAnalysis(user: User, ref: string, id: number, input: z.infer<typeof updateAnalysisSchema>) {
  authorize(user, 'analysis.write');
  await tx(async (db) => {
    const problem = await loadForUpdate(db, ref);
    if (problem.status === 'closed') throw conflict('Reopen the problem before editing analyses');
    const { rows } = await db.query('SELECT * FROM problem_analyses WHERE id = $1 AND problem_id = $2', [id, problem.id]);
    const current = rows[0];
    if (!current) throw notFound('Analysis not found');
    if (input.base_updated_at && new Date(input.base_updated_at).getTime() !== new Date(current.updated_at).getTime()) {
      const { rows: by } = await db.query('SELECT display_name FROM users WHERE id = $1', [current.updated_by]);
      throw conflict(`The analysis was saved by ${by[0]?.display_name ?? 'someone else'} while you were editing`, {
        current: { title: current.title, data: current.data, conclusion: current.conclusion, updated_at: current.updated_at },
        changed_by: by[0]?.display_name ?? null,
        changed_at: current.updated_at,
      });
    }
    const data = input.data === undefined ? current.data : parseData(current.technique, input.data);
    await db.query(
      `UPDATE problem_analyses SET title = $2, data = $3, conclusion = $4, updated_by = $5, updated_at = now() WHERE id = $1`,
      [id, input.title ?? current.title, JSON.stringify(data), input.conclusion ?? current.conclusion, user.id],
    );
    // One activity entry per analysis per 30 minutes, so autosaves do not flood the log.
    const { rows: recent } = await db.query(
      `SELECT 1 FROM problem_activity WHERE problem_id = $1 AND user_id = $2 AND kind = 'analysis'
         AND data->>'analysis_id' = $3 AND created_at > now() - interval '30 minutes'`,
      [problem.id, user.id, String(id)],
    );
    if (!recent[0]) {
      await logActivity(db, problem.id, user.id, 'analysis', `Updated ${TECHNIQUE_LABEL[current.technique as Technique]} analysis`, { analysis_id: id });
    }
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [problem.id]);
  });
  return getProblem(ref);
}

export async function deleteAnalysis(user: User, ref: string, id: number) {
  authorize(user, 'analysis.write');
  await tx(async (db) => {
    const problem = await loadForUpdate(db, ref);
    const { rows } = await db.query('DELETE FROM problem_analyses WHERE id = $1 AND problem_id = $2 RETURNING technique, title', [id, problem.id]);
    if (!rows[0]) throw notFound('Analysis not found');
    await logActivity(db, problem.id, user.id, 'analysis', `Removed analysis: ${rows[0].title}`, { analysis_id: id });
  });
  return getProblem(ref);
}
