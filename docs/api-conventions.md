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

## Webhooks and events

Webhook events are named `<type>.<event>` (`problem.created`, `problem.status_changed`…) and carry ref, title,
status and url, never long texts.

## Copying text between records

Text never moves from a narrower audience into a broader one (#117): not from a restricted record into an
unrestricted one, and not from a confidential record into a normal one. Articles, actions and status updates count as
read by everyone. `server/src/audience.ts` holds the one rule:

- `audienceOf(db, ref)` → `{ restricted, restricted_teams, classification }` of a problem, incident or change.
- `mayCopyText(from, to, kind)` decides; a title (`kind: 'title'`) only stops at restriction, because confidential
  titles stay readable.
- `copyText(db, from, to, text, fallback, path)` returns the text or the fallback (`Resolved with INC000123.`) and
  audits what was left behind.
- A record made from another starts as narrow as its source from its first insert: `startNarrow(from)` passed to
  `createProblemInTx` or `createChange`, so no notice, webhook or event goes out while it is broader.
- `whyNotForEveryone(audience, what)` gives the refusal for paths into something everyone reads (articles).

`test/integration/copy-text.test.ts` runs every path with a restricted and a confidential source and an ordinary one
as positive control, and counts where records are created: a new path fails it until it has a row.

## Checklist for a new practice

1. Migration (`1xx_<practice>.sql`), service module, policy actions, audit entries.
2. REST routes and MCP tools following the tables above; `registerRecordType()`.
3. OpenAPI entries (the coverage test checks all routes), parity test passes.
4. Guidance (`next_steps`), MCP prompt(s), webhook events, UI with the shared record layout.
5. Authorisation matrix rows for the new routes.
6. Every path that copies text from another record goes through `audience.ts` and gets a row in `copy-text.test.ts`.
