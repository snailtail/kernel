// MCP: Follow-up actions on any record (#184): problems, incidents, changes, requests, improvements and reviews.
import { z } from 'zod';
import * as actions from '../actions.js';
import { idempotent } from '../idempotency.js';
import { resolveAssignee, type McpContext } from './registrar.js';

export function registerActionsTools({ user, tool }: McpContext) {
  const actionShape = {
    title: z.string().describe('What needs to be done'),
    description: z.string().optional(),
    owner: z.string().nullable().optional().describe('Username of the person responsible'),
    due_date: z.string().nullable().optional().describe('YYYY-MM-DD'),
    change_ref: z.string().optional().describe('Change implementing the action, e.g. CHG0042'),
  };
  const actionInput = async ({ owner, ...rest }: { owner?: string | null; [k: string]: unknown }) => {
    const owner_id = await resolveAssignee(owner);
    return owner_id === undefined ? rest : { ...rest, owner_id };
  };
  // The tools answer with every action on the record, as they did for problems before #184.
  const actionsOn = (ref: string) => actions.listActions(user, actions.listActionsSchema.parse({ parent: ref, status: 'all' }));
  tool(
    'list_actions',
    'List follow-up actions on every record you may read, e.g. my open actions, everything overdue, or the actions of one record (parent).',
    {
      status: z.enum([...actions.ACTION_STATUSES, 'all']).optional().describe('Default "open"'),
      owner: z.string().optional().describe('Username'),
      overdue: z.boolean().optional(),
      parent: z.string().optional().describe('The actions of this record, e.g. PRB000012, INC000034 or PIR000003'),
      parent_kind: z.enum(actions.ACTION_PARENTS).optional(),
      q: z.string().optional().describe('Matches action title, record ref or record title'),
    },
    true,
    async ({ owner, ...args }) =>
      actions.listActions(user, actions.listActionsSchema.parse({ ...args, owner_id: (await resolveAssignee(owner)) ?? undefined, limit: 100 })),
  );
  tool(
    'add_action',
    'Add a follow-up action, with an owner and due date, to a problem, incident, change, request, improvement or post-incident review (ref).',
    { ref: z.string().describe('The record it follows up, e.g. PRB000012 or PIR000003'), ...actionShape, idempotency_key: z.string().max(200).optional().describe('Retry-safe key') },
    false,
    async ({ ref, idempotency_key, ...args }) =>
      idempotent(user.id, idempotency_key, `add_action ${ref}`, args, async () => {
        await actions.createAction(user, ref, actions.createActionSchema.parse(await actionInput(args)));
        return actionsOn(ref);
      }),
  );
  tool(
    'update_action',
    'Update a follow-up action, or complete/cancel/reopen it via status. Get the action id from list_actions or the record.',
    {
      ref: z.string().optional().describe('The record the action is on (checked when given)'),
      action_id: z.number().int(),
      ...actionShape,
      title: actionShape.title.optional(),
      status: z.enum(actions.ACTION_STATUSES).optional(),
    },
    false,
    async ({ ref, action_id, ...args }) => {
      const a = await actions.updateAction(user, action_id, actions.updateActionSchema.parse(await actionInput(args)), ref);
      return actionsOn(a.ref);
    },
  );
}
