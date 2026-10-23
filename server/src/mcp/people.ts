// MCP: People (#39), teams and on-call (#42).
import { z } from 'zod';
import * as incidents from '../incidents.js';
import * as oncall from '../oncall.js';
import * as people from '../people.js';
import * as teams from '../teams.js';
import { incidentForAgent } from './incidents.js';
import { type McpContext } from './registrar.js';

export function registerPeopleTools({ user, tool }: McpContext) {
  tool('get_on_call', 'Who is on call now per team (or one team), from PagerDuty or Opsgenie when configured, else the built-in rotation. When the tool cannot be reached, unavailable says so; never guess a name.', { team_id: z.number().int().optional() }, true, async ({ team_id }) =>
    oncall.onCall(user, team_id ? [team_id] : undefined),
  );
  tool('list_teams', "Teams (assignment groups): members, the services and CIs they support, and how much open and unassigned work they have. Use a team's id as team_id on incidents, problems and changes.", {}, true, async () =>
    (await teams.listTeams(user)).filter((t: any) => t.active).map((t: any) => ({ id: t.id, name: t.name, members: t.members.map((m: any) => ({ id: m.user_id, name: m.name, role: m.role })), supports: t.supports.map((c: any) => c.ref), open_incidents: t.open_incidents, unassigned: t.unassigned })),
  );
  // Data minimisation: the AI provider gets who a person is, never how to reach them (#39).
  const peopleNotice = 'Returns who people are (name, department, organisation, VIP) but no contact details.';
  tool('search_people', `Find contacts (callers, affected users, service owners) by name, email or department. ${peopleNotice}`, { q: z.string(), limit: z.number().int().min(1).max(50).optional() }, true, async ({ q, limit }) =>
    (await people.listPeople(user, people.listPeopleSchema.parse({ q, limit: limit ?? 20 }))).map((p: any) => ({ id: p.id, name: p.name, department: p.department, organisation: p.organisation, is_vip: p.is_vip })),
  );
  tool('get_person', `A contact with their incidents, the services their organisation consumes and what they own. ${peopleNotice}`, { id: z.number().int() }, true, async ({ id }) => people.withoutContact(await people.getPerson(user, id)));
  tool(
    'add_affected_person',
    'Record that an existing contact is affected by an incident (find them with search_people). Agents cannot create contacts. Many affected people or a VIP raise the suggested impact.',
    { ref: z.string(), id: z.number().int() },
    false,
    async ({ ref, ...person }) => {
      await people.setAffected(user, ref, { id: person.id }, true, false);
      return incidentForAgent(await incidents.getIncident(user, ref));
    },
  );
}
