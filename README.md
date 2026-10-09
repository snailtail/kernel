# Kernel

Kernel is a web-based system for **problem management**, modelled on the ITIL 4 problem management practice.
It has a web UI, a REST API and an **MCP endpoint**, so Claude Code, Claude and other MCP clients can work with
problem records directly.

## Concepts

| Status | ITIL 4 phase | Meaning |
| --- | --- | --- |
| New | Problem identification | Logged, reactively (from incidents) or proactively (from events, trends, risks) |
| Under Analysis | Problem control | Analysis under way; workarounds can be documented at any time |
| Known Error | Error control | Analysed (root cause documented) but not resolved; listed in the known error database |
| Resolved | | Permanent solution in place, usually through a change |
| Closed | | Closed with a closure code by a problem manager |

Rules enforced by the server:

- Known error requires a documented root cause.
- Resolved requires a documented resolution.
- Closing and reopening a closed problem require the Problem Manager (or Administrator) role and a closure code.
- **Major problems** need a major problem review before closure (unless closed as duplicate or cancelled).
- Priority = impact + urgency − 1 (1 Critical … 5 Planning), where impact and urgency are 1 (high) to 3 (low).
- Closing with closure code *no fix* requires a recorded decision to accept the risk (error control).
- Every change is written to the activity log of the problem, with full before/after values (also for long texts).
- Concurrent edits are detected per field: updates may carry `base` (the values the edit started from); if someone else
  changed those fields meanwhile the server answers `409` with the current values and who changed them, and the UI
  lets the user keep theirs, combine or overwrite. Analyses use `base_updated_at` the same way.

**Error control**: each known error can be assessed — risk of not fixing, cost of a permanent fix, workaround
effectiveness — and gets a decision: fix, accept the risk, defer or pending, with a review date. Accepting or
deferring is reserved for problem managers. Dashboards and filters show known errors awaiting a decision or past
their review date.

**Root cause analysis**: problems can carry structured analyses — 5 Whys, Ishikawa (with a fishbone diagram),
Kepner-Tregoe (IS / IS NOT and testing possible causes) and timelines — whose conclusion can be copied into the root cause.

**Reports** show flow (logged vs resolved), backlog over time, lead times per priority, reopened problems,
proactive share, service and category hotspots, known error health and action follow-up for any period, with CSV
export and a print layout.

**Integrations**: external systems get URL templates per record kind, so a linked `INC0012345` becomes a link into
ServiceNow (or Jira, Zabbix…). ITSM and monitoring tools report incidents and events through
`POST /api/integrations/records`, using a token of a user with the *Integration* role (which can report and link
records, nothing else). Records with a `problem_ref` are linked to that problem; unlinked records feed the
**problem candidates** list — services with at least N records in M days — from which a problem can be logged or
linked in one step.

**Guided mode** (on by default, switchable under Settings → Preferences) explains each phase on the problem page and
shows a checklist of the next steps, derived from the record itself; the same guidance is returned to MCP clients as
`next_steps` in `get_problem`. New users are offered a short introduction, "Problem management in 5 minutes".

**Duplicates**: while a problem is being logged, similar problems and known errors (with their workarounds) are
shown live. A problem manager can close a problem as a duplicate of another, which links the two and moves its
incidents and events to the original.

**Problem review**: an agenda for the regular review meeting — problems to triage or without owner, major problems,
known errors awaiting a decision or due for review, stale problems, resolved problems awaiting closure and overdue
actions — with quick assignment, Markdown export and a print layout (MCP: `get_review_agenda`).

**Markdown and export**: text fields and work notes support Markdown (rendered safely, without raw HTML). Any
problem can be exported as a Markdown document or printed / saved as PDF from its print view — handy for major
problem reviews and known error articles (MCP: `export_problem`).

**Webhooks and watching**: administrators register webhooks (generic JSON, Slack, Teams Workflows or legacy Teams connectors) for problem events —
created, status changed, assigned, updated, commented, linked, assessed, analysis, action changed/overdue. Deliveries
are queued in the same transaction as the change, signed per [Standard Webhooks](https://www.standardwebhooks.com/)
(`webhook-id`, `webhook-timestamp`, `webhook-signature`; the legacy `X-Kernel-Signature` is also sent) and retried
with backoff; each webhook has a test button and a delivery log. Payloads carry ref, title, status, a link and short
field changes, never long texts. Signing secrets are shown once, can be rotated, and are encrypted at rest with
`KERNEL_SECRET_KEY`. Outbound requests go through one client that blocks loopback, link-local, cloud metadata and
(unless allowed) private addresses, re-checks redirects and pins the checked IP. Creators and assignees watch problems
automatically, anyone can watch or unwatch, and the dashboard shows changes on watched problems
(MCP: `watch_problem`).

**Guided investigations for people and AI agents**: every flow (5 Whys, Ishikawa, Kepner-Tregoe, timeline, triage,
error control, major problem review, verifying a resolution, reviewing candidates, the review meeting) has a method
guide, shown in the UI and served to MCP clients as `kernel://guides/<id>`, and an MCP prompt. Analyses are checked on
the server against their method (`check_analysis`; the UI shows the same checks), and `get_problem_context` gives an
agent all the evidence in one call. Content written through MCP is marked **Proposed via MCP** until a person confirms
it, history entries show the channel, and decisions through MCP (closing, accepting/deferring risk, marking
duplicates) need the person's quoted confirmation and then, by default, wait as a **pending approval** until a person
approves them in the web UI (an agent's quote could be fabricated after a prompt injection). Record text is handed to
agents as `untrusted_content`, and the MCP instructions tell them it is data, never instructions.

**My work and navigation**: the start page lists what needs you – approvals and decisions waiting on you, your
problems and actions, and changes on what you watch. Ctrl+K or `/` opens a command palette (type a ref such as
`PRB000012` to jump, search everything, or run a command); `g` + a letter goes to a page, `n` logs a problem and `?`
shows all shortcuts. List filters can be saved as named views.

**Follow-up actions** track work that follows from a problem (vendor fixes, monitoring, runbook updates, review
outcomes) with an owner and due date.

**Linked records** connect a problem to records in other systems: *incidents* (reactive), *events* (proactive),
*changes* (implementing the fix) and other *problems*. Each link can have the source system name and a URL.

### Roles

Permissions are defined in one place (`server/src/policy.ts`, deny by default) and enforced the same way for the web
UI, REST and MCP; MCP lists only the tools a role and token may use. An authorisation test matrix covers every role
against every endpoint, plus mass assignment and IDOR cases.

| Role | Can |
| --- | --- |
| Viewer | Read everything |
| Integration | Only report incidents/events (and link them to problems) via the API; cannot read the rest of Kernel |
| Problem Analyst | Log and work problems, add notes and links, resolve |
| Problem Manager | Also close/reopen, flag major problems, manage categories |
| Administrator | Also manage users |

## Running with Docker

```sh
cp .env.example .env      # set POSTGRES_PASSWORD (and optionally KERNEL_ADMIN_PASSWORD)
docker compose up -d --build
docker compose logs app   # shows the generated admin password if KERNEL_ADMIN_PASSWORD was empty
```

Open http://localhost:8080 and sign in as `admin`. Database migrations run automatically at startup.

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | | PostgreSQL connection string |
| `KERNEL_ADMIN_PASSWORD` | generated | Password for the initial `admin` user (first start only) |
| `KERNEL_SESSION_DAYS` | `7` | Web session lifetime |
| `KERNEL_SECURE_COOKIES` | `false` | Always mark the session cookie Secure. Without it, the cookie is Secure whenever the request arrived over HTTPS (needs `KERNEL_TRUST_PROXY` behind a proxy) |
| `KERNEL_TRUST_PROXY` | `false` | Proxies whose `X-Forwarded-*` headers are trusted: a comma-separated list of addresses/CIDRs (recommended, e.g. `172.16.0.0/12` for a proxy reaching Kernel through Docker), a hop count, or `true` (only if Kernel is unreachable except through the proxy) |
| `KERNEL_MCP_URL` | UI origin + `/mcp` | MCP endpoint shown in Settings, e.g. a LAN address when the public hostname is behind Cloudflare Access |
| `KERNEL_PUBLIC_URL` | – | Public URL of the UI, used for links in webhook messages |
| `KERNEL_LOG_FORMAT` | `json` | `ecs` writes Elastic Common Schema JSON logs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | Enables OpenTelemetry traces and metrics over OTLP (standard `OTEL_*` variables apply) |
| `KERNEL_APP_DB_PASSWORD` | – | Run the app as the least-privilege role `kernel_app` (created and granted automatically; `DATABASE_URL`'s owner only runs migrations). Strongly recommended |
| `KERNEL_SECRET_KEY` | – | Encrypts stored secrets at rest (≥ 32 random characters); required for webhooks |
| `KERNEL_OUTBOUND_ALLOW` | – | CIDRs/addresses on private networks that webhooks may reach (loopback, link-local and metadata addresses are always blocked) |
| `KERNEL_WEBHOOK_RETENTION_DAYS` | `30` | Successful deliveries are deleted after this many days, failed after three times as long |
| `KERNEL_SESSION_IDLE_HOURS` | `12` | Sessions unused for this long expire (absolute lifetime: `KERNEL_SESSION_DAYS`) |
| `KERNEL_HIBP_CHECK` | `false` | Also check new passwords against Have I Been Pwned (k-anonymity; only a hash prefix leaves Kernel) |
| `PORT` | `8080` | Listen port inside the container |

To deploy to the test server, push your commits and run `scripts/deploy.sh`. It pulls `main` in `~/kernel` on
`dockerhost` (a clone using a read-only deploy key), rebuilds the containers and waits until the app is healthy.

`GET /healthz` checks the app and its database connection, for container health checks and Kubernetes probes.

## Security

- Strict Content Security Policy (no inline or eval scripts, no framing), HSTS, `nosniff`, a restrictive
  `Permissions-Policy`, `Cache-Control: no-store` on API responses and a 256 kB request body limit.
- Cookie-authenticated writes need the `X-Kernel-Request` header, a same-origin `Origin`/`Sec-Fetch-Site` and a
  JSON body; bearer tokens are exempt. Sessions use `HttpOnly`, `SameSite=Lax` and `Secure` over HTTPS.
- Passwords follow NIST SP 800-63B: at least 12 characters, no composition rules, rejected if common, containing the
  user's name, or (optionally) found in breaches. Logins are limited per client and per account (temporary lockout,
  logged as a security event, identical for unknown accounts). Sessions expire after inactivity and have an absolute
  lifetime; users see and revoke their sessions in Settings, and a password change signs out other sessions.
- Two-factor authentication with any TOTP authenticator app, plus single-use recovery codes; replayed codes are
  rejected and the secret is encrypted with `KERNEL_SECRET_KEY`. Administrators can require it per role
  (Administration → Security status) and reset it for a user.
- API tokens (`kernel_pat_…`) have scopes — `read`, `write`, `mcp`, `ingest`, read-only by default — and a mandatory
  expiry (at most `KERNEL_TOKEN_MAX_DAYS`, 365); the last used time and address are shown.
- Sensitive actions (creating API tokens, managing users and roles, webhooks, two-factor settings) need a
  re-authentication within the last 10 minutes (`KERNEL_STEPUP_MINUTES`) and are not available with API tokens.
- A device where the account signed in before can still sign in while the account is locked by failed attempts
  from elsewhere, so nobody can lock a user out deliberately.
- The generated initial admin password must be changed at first login. **Administration → Security status** lists the
  security-relevant configuration.
- **Audit trail**: every change and administrative action is recorded with actor, actor type (web user, API token,
  MCP, integration, system), channel, IP and before/after values, plus a mandatory reason for sensitive admin actions.
  The table is append-only (triggers, and the runtime role has no UPDATE/DELETE and does not own it), entries are
  hash-chained and verified hourly, and each entry's id and hash go to the `kernel.audit` log stream as an external
  anchor. Administration → Audit trail searches and exports it; MCP has `get_history` and `query_audit_log`.
- With `KERNEL_APP_DB_PASSWORD` the app runs as a least-privilege PostgreSQL role without DDL rights.
- Containers run with a read-only filesystem, no Linux capabilities beyond what PostgreSQL needs,
  `no-new-privileges` and memory/PID limits. PostgreSQL is not published on the host.
- Reference deployment: Cloudflare Tunnel with Cloudflare Access in front of the public hostname, the MCP endpoint
  only on the LAN (or behind Access with a service token), `KERNEL_TRUST_PROXY` set to the proxy's network, and
  `KERNEL_SECRET_KEY` set.

## Observability (Elasticsearch)

Kernel can be observed with the Elastic stack, or any OpenTelemetry backend:

- **Logs** – set `KERNEL_LOG_FORMAT=ecs` and the container writes [ECS](https://www.elastic.co/guide/en/ecs/current/index.html)
  JSON to stdout, ready for Filebeat or Elastic Agent without custom parsing (`event.dataset: kernel`). Requests are
  logged with method, path, client address and status only; cookies, bearer tokens, `Set-Cookie`, passwords and
  secrets are always redacted.
- **Problem management events** – every change to a problem (logged, status changed, assigned, commented, linked,
  assessed, actions…) is also written as a domain event with `event.dataset: kernel.problem`, `event.action`
  (e.g. `problem.status_changed`), `problem.ref`, `problem.status`, `problem.priority`, `problem.category`,
  `problem.service` and `user.name`. Route that dataset to its own data stream and chart the process itself in
  Kibana: flow per status, lead times, hotspots.
- **Traces and metrics** – set `OTEL_EXPORTER_OTLP_ENDPOINT` (and `OTEL_EXPORTER_OTLP_HEADERS` for authentication) to
  send OpenTelemetry data over OTLP/HTTP to Elastic APM Server, an EDOT collector or any OTLP collector. HTTP requests,
  Fastify routes, PostgreSQL queries and MCP tool calls become spans; metrics include `kernel.problem.created`,
  `kernel.problem.transitions` and `kernel.mcp.tool_calls`.

Example `.env` for Elastic Cloud / APM and ECS logs:

```sh
KERNEL_LOG_FORMAT=ecs
OTEL_EXPORTER_OTLP_ENDPOINT=https://<deployment>.apm.<region>.cloud.es.io:443
OTEL_EXPORTER_OTLP_HEADERS=Authorization=ApiKey <base64 api key>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
```

Example Filebeat input for the container logs (Elastic Agent's Docker integration works the same way):

```yaml
filebeat.inputs:
  - type: filestream
    id: kernel
    paths: ["/var/lib/docker/containers/*/*.log"]
    parsers:
      - container: ~
      - ndjson:
          target: ""
          overwrite_keys: true
          expand_keys: true
    processors:
      - add_docker_metadata: ~
      - drop_event:
          when.not.equals.container.labels.com_docker_compose_service: app
```

## MCP

The MCP endpoint is `http://<host>:8080/mcp` (Streamable HTTP, stateless). Clients authenticate with a personal
API token with the `mcp` scope (plus `read`, and `write` for tools that change data), created under **Settings → API
tokens & MCP**, and act as that user with that user's role.

```sh
claude mcp add --transport http kernel http://dockerhost:8080/mcp \
  --header "Authorization: Bearer kernel_pat_..."
```

Prompts (slash commands in Claude Code, e.g. `/mcp__kernel__five_whys PRB000012`): `five_whys`, `ishikawa`,
`kepner_tregoe`, `timeline`, `triage_problem`, `assess_known_error`, `major_problem_review`, `verify_resolution`,
`review_candidates`, `problem_review_board`. Resources: `kernel://guides/<id>` and `kernel://problems/{ref}`. They let Claude facilitate the analysis or review with you and record the
result in Kernel.

Tools: `whoami`, `list_reference_data`, `search_problems`, `get_problem`, `search_known_errors`, `get_dashboard`,
`create_problem`, `update_problem`, `transition_problem`, `add_comment`, `link_record`, `unlink_record`,
`assess_known_error`, `start_analysis`, `update_analysis`, `list_actions`, `add_action`, `update_action`, `get_report`,
`list_problem_candidates`, `create_problem_from_candidate`, `link_candidate_records`, `report_records`,
`find_similar_problems`, `mark_duplicate`, `get_review_agenda`, `export_problem`, `watch_problem`, `get_history`,
and the cross-practice tools `search`, `get_record`, `next_steps`, `my_work`, `link_records`.

## API conventions

All record types follow the same REST and MCP conventions (refs, `url`, `next_steps`, `Idempotency-Key`, conflict
detection, error format, generic `search`/`get_record`/`next_steps`/`my_work`/`link_records`), enforced by a parity
test. See [docs/api-conventions.md](docs/api-conventions.md).

## REST API

The full, machine-readable description is served at `/api/openapi.json` (OpenAPI 3.1, generated from the same
schemas the server validates with) and rendered under **API reference** in the UI. All endpoints are under `/api` and accept either the session cookie (web UI) or `Authorization: Bearer krn_...`.
Cookie-authenticated requests that change data must send the header `X-Kernel-Request: 1`.

| Method | Path | |
| --- | --- | --- |
| GET | `/api/problems?q=&status=&priority=&assignee_id=&category_id=&is_major=&sort=` | Search problems (`status` defaults to `open`) |
| POST | `/api/problems` | Log a problem |
| GET / PATCH | `/api/problems/:ref` | Read or update a problem |
| POST | `/api/problems/:ref/transition` | Change status: `{ to, closure_code?, comment?, root_cause?, workaround?, resolution?, major_review? }` |
| POST | `/api/problems/:ref/comments` | Add a work note |
| POST / DELETE | `/api/problems/:ref/links[/:id]` | Link or unlink an incident, event, change or problem |
| GET | `/api/kedb?q=&include_resolved=` | Known error database |
| POST | `/api/integrations/records` | Report incidents/events: `{ records: [{ system, kind, reference, service?, summary?, occurred_at?, problem_ref? }] }` |
| GET | `/api/candidates` | Problem candidates; `POST /api/candidates/create`, `/link`, `/dismiss` act on them |
| GET | `/api/dashboard` | Backlog summary |
| GET | `/api/reports?from=&to=&bucket=` | KPIs and trends for a period |
| GET | `/api/reports/problems.csv?from=&to=` | Problems active in the period as CSV |

## Development

Requires Node.js 24 and PostgreSQL.

```sh
npm install
DATABASE_URL=postgres://kernel:kernel@localhost:5432/kernel npm run dev:server   # API on :8080
npm run dev:web                                                                   # UI on :5173, proxies /api and /mcp
npm run typecheck
npm run test:unit                                                                 # unit tests only
TEST_DATABASE_URL=postgres://kernel:kernel@localhost:5432/kernel_test npm test   # all tests; WIPES that database
```

Layout: `server/` (Fastify, TypeScript, PostgreSQL, MCP SDK) and `web/` (React, Vite). Business rules live in
`server/src/workflow.ts` and `server/src/problems.ts`, which both the REST API and the MCP server use.
`npm run seed:demo -w server` fills an **empty** database (from `DATABASE_URL`) with realistic demo users and problems,
useful for trying Kernel out or demonstrating problem management. Demo users have the password `demo-password`.

Schema changes go in a new numbered file in `server/migrations/`.

Integration tests (`server/test/integration/`) start Kernel against `TEST_DATABASE_URL` and exercise the REST API and the
MCP server through the official MCP client. CI (`.github/workflows/ci.yml`) runs typecheck, all tests, the build and a
Docker image build on every push and pull request.
