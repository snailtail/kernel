// Reference data every practice reads (#171): it belongs to no single practice, so it has a route of its own.
import type { FastifyInstance } from 'fastify';
import * as actions from '../actions.js';
import * as analyses from '../analyses.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { modules } from '../modules.js';
import * as problems from '../problems.js';
import { hiddenRecordsExist } from '../visibility.js';
import { CLOSURE_CODES, EC_DECISIONS, ROLES, STATUSES, TRANSITIONS, WORKAROUND_EFFECTIVENESS } from '../workflow.js';

export async function metaRoutes(app: FastifyInstance) {
  app.get('/api/meta', async (req) => {
    requireUser(req, 'meta.read');
    const [categories, users] = await Promise.all([
      query('SELECT id, name, active FROM categories ORDER BY name'),
      query("SELECT id, display_name, role FROM users WHERE active AND role NOT IN ('viewer', 'integration') ORDER BY display_name"),
    ]);
    const { rows: setupRows } = await query("SELECT value FROM settings WHERE key = 'setup'");
    return {
      modules: modules(),
      setup_completed: !!setupRows[0]?.value?.completed,
      statuses: STATUSES,
      transitions: TRANSITIONS,
      closure_codes: CLOSURE_CODES,
      roles: ROLES,
      link_kinds: problems.LINK_KINDS,
      action_statuses: actions.ACTION_STATUSES,
      techniques: analyses.TECHNIQUES,
      ec_decisions: EC_DECISIONS,
      workaround_effectiveness: WORKAROUND_EFFECTIVENESS,
      mcp_url: config.mcpUrl,
      categories: categories.rows,
      assignees: users.rows,
      // Managers' numbers leave out restricted records they cannot see; the UI says so (a yes/no, never a count).
      hidden_records: ['admin', 'problem_manager'].includes(req.user!.role) ? await hiddenRecordsExist() : false,
    };
  });

  // Everyone who reads reports, on the same permission as the KPIs, not the problem one.
  app.get('/api/dashboard', async (req) => problems.dashboard(requireUser(req, 'report.read')));
}
