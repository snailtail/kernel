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
- Every change is written to the activity log of the problem.

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

**Follow-up actions** track work that follows from a problem (vendor fixes, monitoring, runbook updates, review
outcomes) with an owner and due date.

**Linked records** connect a problem to records in other systems: *incidents* (reactive), *events* (proactive),
*changes* (implementing the fix) and other *problems*. Each link can have the source system name and a URL.

### Roles

| Role | Can |
| --- | --- |
| Viewer | Read everything |
| Integration | Report incidents/events and link them to problems via the API (for ITSM and monitoring tools) |
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
| `KERNEL_TRUST_PROXY` | `false` | Set `true` behind a reverse proxy or Cloudflare Tunnel, so `X-Forwarded-*` headers give the client IP and protocol |
| `KERNEL_MCP_URL` | UI origin + `/mcp` | MCP endpoint shown in Settings, e.g. a LAN address when the public hostname is behind Cloudflare Access |
| `KERNEL_PUBLIC_URL` | – | Public URL of the UI, used for links in webhook messages |
| `KERNEL_LOG_FORMAT` | `json` | `ecs` writes Elastic Common Schema JSON logs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | Enables OpenTelemetry traces and metrics over OTLP (standard `OTEL_*` variables apply) |
| `KERNEL_SECRET_KEY` | – | Encrypts stored secrets at rest (≥ 32 random characters); required for webhooks |
| `KERNEL_OUTBOUND_ALLOW` | – | CIDRs/addresses on private networks that webhooks may reach (loopback, link-local and metadata addresses are always blocked) |
| `KERNEL_WEBHOOK_RETENTION_DAYS` | `30` | Successful deliveries are deleted after this many days, failed after three times as long |
| `PORT` | `8080` | Listen port inside the container |

To deploy to the test server, push your commits and run `scripts/deploy.sh`. It pulls `main` in `~/kernel` on
`dockerhost` (a clone using a read-only deploy key), rebuilds the containers and waits until the app is healthy.

`GET /healthz` checks the app and its database connection, for container health checks and Kubernetes probes.

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
API token, created under **Settings → API tokens & MCP**, and act as that user with that user's role.

```sh
claude mcp add --transport http kernel http://dockerhost:8080/mcp \
  --header "Authorization: Bearer krn_..."
```

Prompts (slash commands in Claude Code, e.g. `/mcp__kernel__five_whys PRB000012`): `five_whys`, `kepner_tregoe`,
`triage_problem`, `major_problem_review`. They let Claude facilitate the analysis or review with you and record the
result in Kernel.

Tools: `whoami`, `list_reference_data`, `search_problems`, `get_problem`, `search_known_errors`, `get_dashboard`,
`create_problem`, `update_problem`, `transition_problem`, `add_comment`, `link_record`, `unlink_record`,
`assess_known_error`, `start_analysis`, `update_analysis`, `list_actions`, `add_action`, `update_action`, `get_report`,
`list_problem_candidates`, `create_problem_from_candidate`, `link_candidate_records`, `report_records`,
`find_similar_problems`, `mark_duplicate`, `get_review_agenda`, `export_problem`, `watch_problem`.

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
