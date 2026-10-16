# API and MCP conventions

Every practice in Kernel (problem management today; incidents, changes, events, CIs… later) follows the same
conventions, so people, scripts and AI agents can work with all of it in one predictable way. A parity test
(`server/test/integration/parity.test.ts`) fails the build when a record type breaks them.

## One service layer, three surfaces

Business rules live in `server/src/<practice>.ts`. The web UI, the REST API and the MCP server all call that layer;
nothing exists only in a route, an MCP tool or the UI. Permissions come from `server/src/policy.ts` (deny by default)
and every change writes the audit trail (`server/src/audit.ts`) in the same transaction.

## Records

- Every record has a **ref** with a type prefix (`PRB000012`), a **type** (`problem`) and a **url** to the web UI.
- A new record type registers itself with `registerRecordType()` (`server/src/records.ts`): prefix, read permission,
  UI path, `get`, `search`, and its REST routes and MCP tools.
- `get` returns the record with `links`, `activity` (history) and `next_steps` (guided mode).

## REST

| Purpose | Route |
| --- | --- |
| List / search | `GET /api/<type>s?q=&status=&…` |
| Create | `POST /api/<type>s` |
| Read | `GET /api/<type>s/:ref` |
| Update fields | `PATCH /api/<type>s/:ref` (optionally with `base` for conflict detection) |
| Change status | `POST /api/<type>s/:ref/transition` |
| Links | `POST /api/<type>s/:ref/links`, `DELETE …/links/:id` |
| Comments | `POST /api/<type>s/:ref/comments` |

Cross-practice: `GET /api/search?q=`, `GET /api/records/:ref`, `GET /api/records/:ref/next-steps`,
`POST /api/records/:ref/links`, `GET /api/my-work`.

Lists (#110): saved views at `GET/POST /api/views`, `PATCH/DELETE /api/views/:id` and `PUT /api/views/default`. Bulk
actions at `POST /api/<list>/bulk` with `{ ids | filter, operation, dry_run }`, or `{ items }` (as returned in `undo`).
A bulk operation calls the same service function as a single edit for each record (`server/src/bulk.ts`), so a new
practice adds its operations there instead of writing to its tables. The answer has an outcome per record
(`changed`, `would_change`, `unchanged`, `skipped`, `failed` with the reason). At most 500 records are allowed per request;
clients send large selections in chunks so each request stays well within proxy timeouts (the web UI uses 50).
- A bulk change pages on-call teams exactly as single edits would. The answer (and the dry run) counts the pages per
  team, and a request that would page a team more than once is refused with 409 unless it carries `confirm_paging: true`.
- Bulk is an explicit mass change: it does not take `base`, so it does not detect a concurrent edit, and an `undo`
  sets the values from before the bulk change even if someone has changed the record since.

- Errors are `{ "error": "message" }` plus optional details (e.g. `conflicts` on 409). Status codes: 400 invalid
  input, 401 not signed in, 403 not allowed (or a missing step-up / token scope), 404 not found, 409 conflicts with
  the current state or a workflow rule, 422 misused idempotency key, 429 rate limited.
- Routes that create ordinary records opt in to an **`Idempotency-Key`** header (route config `idempotent: <action>`);
  a retry with the same key and body returns the original response (`Idempotent-Replayed: true`), a different body
  gives 422, a failed request may be retried. The caller is authorised again before any replay. Routes that return
  secrets (tokens, webhook/TOTP secrets, recovery codes) never opt in. MCP create tools take `idempotency_key`.
- Concurrent edits: send `base` (the values the edit started from); changes by others to the same fields give 409
  with the current values instead of being overwritten.
- Request bodies are JSON validated by zod schemas; unknown fields are ignored, server-controlled fields (ids,
  status, timestamps, creator) are never taken from the client. The same schemas generate `/api/openapi.json`.

## MCP

- Per type: `search_<type>s`, `get_<type>`, `create_<type>`, `update_<type>`, `transition_<type>`, plus the
  practice's specific tools.
- Cross-practice: `search`, `get_record`, `next_steps`, `my_work`, `link_records`, `add_comment`, `get_history`.
- Tool descriptions briefly explain the ITIL purpose so agents follow the process. Tools a role or token scope may
  not use are not listed. Every tool maps to a policy action (`TOOL_ACTIONS` in `mcp.ts`).
- Every practice also ships **guided flows**: a method guide (`server/src/methods.ts`, UI + MCP resource
  `kernel://guides/<id>`), an MCP prompt per flow, a server-side check (like `check_analysis`) and `next_steps`.
  Content written through MCP is marked as proposed until a person confirms it; decisions through MCP take a
  `human_confirmation` argument and are flagged `destructiveHint`.
- `bulk_update` previews unless `apply: true`; decisions (closing problems) stay with their own tools.

## Webhooks and events

Webhook events are named `<type>.<event>` (`problem.created`, `problem.status_changed`…) and carry ref, title,
status and url, never long texts.

## Copying text between records

Text never moves from a narrower audience into a broader one (#117): not from a restricted record into an
unrestricted one, and not from a confidential record into a normal one. Articles, actions and status updates count as
read by everyone. `server/src/audience.ts` holds the one rule:

- `audienceOf(db, ref)` → `{ restricted, restricted_teams, classification }` of a problem, incident or change.
- `mayCopyText(from, to, kind)` decides; a title (`kind: 'title'`) only stops at restriction, because confidential
  titles stay readable. A restriction without teams is the narrowest (only the record's assignee and creator), so any
  team on the target is broader. The rule compares restriction, teams and classification only: it does not follow who
  is assignee or creator on each record, which can differ between a source and its target.
- `copyText(db, from, to, text, fallback, path)` returns the text or the fallback (`Resolved with INC000123.`) and
  audits what was left behind.
- A record made from another starts as narrow as its source from its first insert: `startNarrow(from)` passed to
  `createProblemInTx` or `createChange`, so no notice, webhook or event goes out while it is broader.
- `whyNotForEveryone(audience, what)` gives the refusal for paths into something everyone reads (articles).

`test/integration/copy-text.test.ts` runs every path with a restricted and a confidential source and an ordinary one
as positive control, and counts where records are created: a new path fails it until it has a row.

## Problem candidates

Candidates (`server/src/candidates.ts`, #31) are computed on read by rules, as the viewer, so row-level security decides
which records count. Each has a stable `key` (rule + subject, e.g. `common_upstream:ci:CI000012`), a `rule`, a readable
`reason` and `evidence` (records with keys such as `i:INC000123`, CIs with their role). Only rule settings
(`candidate_rules`), decisions (`candidate_decisions`: a dismissal covers the evidence it was made on, a snooze a time)
and reported candidates (`reported_candidates`, idempotent on source + external key) are stored. Act on a candidate by
key: the server prefills the problem from the evidence under the copy rules above and links every record. A new rule
is a function returning candidates with a `finish(records)` that gives the reason or null, plus a row in `RULES`.

## Checklist for a new practice

1. Migration (`1xx_<practice>.sql`), service module, policy actions, audit entries.
2. REST routes and MCP tools following the tables above; `registerRecordType()`.
3. OpenAPI entries (the coverage test checks all routes), parity test passes.
4. Guidance (`next_steps`), MCP prompt(s), webhook events, UI with the shared record layout.
5. Authorisation matrix rows for the new routes.
6. Every path that copies text from another record goes through `audience.ts` and gets a row in `copy-text.test.ts`.
