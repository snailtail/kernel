// MCP: Problem detection (candidates) and records reported from other systems.
import { z } from 'zod';
import * as config from '../candidate-config.js';
import * as candidates from '../candidates.js';
import * as integrations from '../integrations.js';
import { compactProblem } from './problems.js';
import { optionalEditable } from './problems.js';
import { toInput } from './problems.js';
import { type McpContext } from './registrar.js';

export function registerCandidatesTools({ user, tool }: McpContext) {
  tool(
    'list_problem_candidates',
    'Problem detection: groups of records worth a problem, found by rules (recurring records on a CI or service, incidents sharing an underlying CI, a major incident resolved without a problem, the same category and resolution) or reported by external analysis. Each has a key, its rule, a readable reason and evidence (records, CIs). Act on a candidate by its key.',
    { rule: z.enum(candidates.RULE_IDS).optional().describe('Only this rule'), show: z.enum(['open', 'hidden']).optional().describe('hidden: dismissed or snoozed candidates') },
    true,
    (args) => candidates.listCandidates(args),
  );
  tool(
    'create_problem_from_candidate',
    'Log a new problem from a candidate and link its records. With key, the problem is prefilled from the evidence (title, description listing the evidence, CIs, service) and any field you give overrides it. Without key, give the records and a title.',
    { key: z.string().max(300).optional().describe('Candidate key from list_problem_candidates'), record_ids: z.array(z.number().int()).optional(), incident_refs: z.array(z.string()).optional().describe('Native incidents in the candidate'), alert_ids: z.array(z.number().int()).optional().describe('Monitoring alerts in the candidate'), ...optionalEditable },
    false,
    async ({ key, record_ids, incident_refs, alert_ids, ...fields }) => {
      const input = candidates.candidateActionSchema.parse({ key, record_ids: record_ids ?? [], incident_refs: incident_refs ?? [], alert_ids: alert_ids ?? [] });
      return compactProblem(await candidates.createFromCandidate(user, { ...input, problem: candidates.problemOverridesSchema.parse(await toInput(fields)) }), 5);
    },
  );
  tool(
    'link_candidate_records',
    'Link a candidate (by key) or its records to an existing problem.',
    { ref: z.string(), key: z.string().max(300).optional().describe('Candidate key from list_problem_candidates'), record_ids: z.array(z.number().int()).optional(), incident_refs: z.array(z.string()).optional(), alert_ids: z.array(z.number().int()).optional() },
    false,
    async ({ ref, key, record_ids, incident_refs, alert_ids }) =>
      (await candidates.linkCandidate(user, ref, candidates.candidateActionSchema.parse({ key, record_ids: record_ids ?? [], incident_refs: incident_refs ?? [], alert_ids: alert_ids ?? [] }))).links,
  );
  tool(
    'dismiss_problem_candidate',
    'Dismiss a candidate for the evidence it has now (it comes back only if new records meet the rule on their own), or snooze it until a time. A reason is required and audited; agree it with the person first.',
    { key: z.string().max(300), reason: z.string().max(1000), until: z.string().optional().describe('ISO time to snooze until, instead of dismissing') },
    false,
    (args) => candidates.decideCandidate(user, candidates.decisionSchema.parse(args)),
  );
  tool('list_eol_versions', 'The end-of-life table behind the "versions at end of life" candidate rule: product, version and date.', {}, true, () => config.listEol());
  tool(
    'save_eol_version',
    'Add or change a row in the end-of-life table (managers). CIs whose os, or engine/product and version, match it become candidates near or after the date.',
    { id: z.number().int().optional().describe('Row to change; omit to add'), ...config.eolSchema.shape },
    false,
    async ({ id, ...row }) => config.saveEol(user, id ?? null, config.eolSchema.parse(row)),
  );
  tool(
    'report_problem_candidate',
    'Report a problem candidate from your own analysis (for example of logs or metrics), with evidence: Kernel incident refs, alert ids, CI refs, and external findings (reference, summary, time, URL). Reporting the same source + external_key again updates it. Secrets in the text are redacted; send references and short summaries, not whole logs (64 KB at most).',
    candidates.reportSchema.shape,
    false,
    async (args) => candidates.reportCandidate(user, candidates.reportSchema.parse(args)),
  );
  tool(
    'report_records',
    'Report incidents or events from another system (e.g. while handling an incident). Optionally link each to a problem via problem_ref. Idempotent per system+kind+reference.',
    { records: z.array(integrations.recordSchema).min(1).max(100) },
    false,
    async (args) => integrations.ingestRecords(user, integrations.ingestSchema.parse(args)),
  );
}
