# API and MCP conventions

Every practice in Kernel follows the same
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
- `get` returns the **envelope** `ref`, `type`, `status`, `url` and `next_steps` (guided mode), over REST and MCP alike,
  plus the record's own fields, links and activity.

Registered types:

| Type | Ref | Module | REST | MCP get |
| --- | --- | --- | --- | --- |
| problem | `PRB000012` | always on | `/api/problems` | `get_problem` |
| incident | `INC000123` | incident | `/api/incidents` | `get_incident` |
| review (post-incident review) | `PIR000004` | incident | `/api/reviews` | `get_review` |
| change | `CHG000045` | change | `/api/changes` | `get_change` |
| ci | `CI000012` | cmdb | `/api/cis` | `get_ci` |
| service | `SVC000003` | cmdb | `/api/cis` | `get_ci` |
| article | `KB000007` | knowledge | `/api/articles` | `get_article` |
| improvement | `IMP000012` | always on | `/api/improvements` | `get_improvement` |
| request (service request) | `REQ000012` | request (off by default) | `/api/requests` | `get_request` |

A post-incident review also answers to its incident's ref (`/api/incidents/INC000123/review`, `get_review` with
`INC000123`), and shares its incident's links: linking from or to a review links the incident. Its comments are kept
in the incident's activity, marked with the review, and shown on the review. Its visibility and confidentiality are
the incident's.

An improvement (continual improvement register, #52) keeps the links to the changes, problems, actions (by id),
incidents and reviews that carry it out, whichever side the link starts from: linking a problem to an improvement
stores the link on the improvement. One made from a review, a problem or a service review names it in `source_ref` and
starts as narrow as that record (restricted, confidential).

A service request (#44) is made from a catalogue item (`/api/request-items`, `list_request_items`) for a person in
People, by the user who logs it. Its `answers` are checked against the item's form on the server; free-text answers
come back as `answer_text` and are masked like other free text on a confidential request. Approving and rejecting are
a person's decision: `POST /api/requests/:ref/approval` signed in, or the approval link (#48), never an API token or
MCP. Tasks are done in order (`POST /api/requests/:ref/tasks/:id/complete`, `complete_request_task`).

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

Cross-practice, for any ref: `GET /api/search?q=`, `GET /api/records/:ref`, `GET /api/records/:ref/next-steps`,
`GET /api/records/:ref/history`, `GET /api/records/:ref/impact` (CIs and services; other types give 400),
`POST /api/records/:ref/links`, `POST /api/records/:ref/comments`, `GET /api/my-work`.

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
- Notifications during a bulk request are held back and sent as one summary per person when it finishes (#125). They
  are held in memory, so a crash mid-request loses those notices; the changes themselves are committed and audited.

- Errors are `{ "error": "message" }` plus optional details (e.g. `conflicts` on 409). Status codes: 400 invalid
  input, 401 not signed in, 403 not allowed (or a missing step-up / token scope), 404 not found, 409 conflicts with
  the current state or a workflow rule, 422 misused idempotency key, 429 rate limited.
- Routes that create ordinary records opt in to an **`Idempotency-Key`** header (route config `idempotent: <action>`);
  a retry with the same key and body returns the original response (`Idempotent-Replayed: true`), a different body
  gives 422, a failed request may be retried. The caller is authorised again before any replay. Routes that return
  secrets (tokens, webhook/TOTP secrets, recovery codes) never opt in. MCP create tools take `idempotency_key`.
- Concurrent edits: send `base` (the values the edit started from); changes by others to the same fields give 409
  with the current values instead of being overwritten.
- A **reason** (for deleting, retracting, redacting) always goes in the JSON body, never in the query string:
  query strings end up in proxy, gateway and request logs, and a reason may describe people. A route that needs one
  is a `POST …/<verb>` with `{ "reason": "…" }` checked by `requireReason` (e.g. `POST /api/webhooks/:id/delete`,
  `POST /api/status/updates/:id/retract`).
- Request bodies are JSON validated by zod schemas; unknown fields are ignored, server-controlled fields (ids,
  status, timestamps, creator) are never taken from the client. The same schemas generate `/api/openapi.json`.

## MCP

- Per type: `search_<type>s`, `get_<type>`, `create_<type>`, `update_<type>`, `transition_<type>`, plus the
  practice's specific tools.
- Cross-practice, for any ref:

  | Tool | Does |
  | --- | --- |
  | `search` | All record types you may read, by words or ref |
  | `get_record` | Any record by ref, in the envelope above |
  | `next_steps` | The record's process phase and remaining steps |
  | `get_history` | Who changed what, from the audit trail (the type's read permission and visibility apply) |
  | `get_impact` | What depends on a CI or service, up to services (`get_ci_impact` under the generic name) |
  | `link_records` | Link two records, or a record and an external reference |
  | `add_comment` | A work note on any record |
  | `my_work` | Your open work across practices |

- Tools are renamed only by adding the new name next to the old one; an old name is never removed.
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
Rules marked `proactive` (trends in events and changes, `server/src/candidate-trends.ts`, and reported findings) show
under "Before it hurts" and carry `evidence.series`: one value per day, oldest first, with `split` where two windows
are compared. For these, a dismissal holds until a new alert or change joins the trend; snooze for a time-boxed pause.
`detection` on the prefilled problem is reactive when incidents in the evidence already happened, proactive otherwise.

## Checklist for a new practice

1. Migration (`1xx_<practice>.sql`) with a ref column (`'XYZ' || lpad(nextval(…), 6, '0')`), service module, policy
   actions, and audit entries with `entity_type` = the type (or set `history.entityType` in the registration).
2. REST routes and MCP tools following the tables above; `registerRecordType()` with all of them, a `pattern` for the
   ref, and `get` returning the envelope with `next_steps`.
3. Teach the generic tools about it where they dispatch per type: `addComment` and `linkRecords` in
   `server/src/generic.ts`.
4. OpenAPI entries (the coverage test checks all routes). Add a way to make one to `MAKE` in
   `test/integration/parity.test.ts`: the test then checks its routes, tools, envelope (REST and MCP), search by ref,
   comments and history, and fails for a registered type without an entry.
5. If the practice can be switched off, its policy actions belong to a module (`moduleOfAction` in
   `server/src/modules.ts`), so its routes answer 404 and its tools are not listed while it is off.
6. Guidance (`next_steps`), MCP prompt(s), webhook events, UI with the shared record layout.
7. Authorisation matrix rows for the new routes.
8. Every path that copies text from another record goes through `audience.ts` and gets a row in `copy-text.test.ts`.
