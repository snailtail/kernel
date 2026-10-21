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

**CMDB**: configuration items and services as pointers to where they really live (vCenter, Azure, OP5…), with
typed attributes per CI type, source links, linked records and history. Source systems report CIs through
`POST /api/cis/upsert` (or the `upsert_cis` MCP tool), matched by source system and id; an integration account can
only update the source records it created.

**Connectors and the push contract**: administrators add pull connectors under Administration → Connectors (OP5
Monitor: hosts become CIs, current service problems become alerts that clear when fixed; Kubernetes: cluster, nodes,
namespaces and workloads with a read-only ServiceAccount, see
[docs/connectors/kubernetes.md](docs/connectors/kubernetes.md)). Credentials are encrypted and never shown again, runs
never overlap, and every run is logged. A connector reaches only the private addresses it lists (e.g. the OP5 server
on the LAN). Anything else pushes with `POST /api/cmdb/ci-batch` or the MCP tool `sync_ci_batch`: CIs and
relationships from one source, matched to existing CIs by source id, an explicit CI ref, resource id, FQDN or name and
IP. With `full_sync`, CIs a source stops reporting count as missed and become `missing` after three syncs;
`incomplete_prefixes` leaves the source ids under a prefix alone (a kind that could not be read this time); a snapshot
that shrank by more than half is refused for that step. Per-attribute source precedence decides which source's value
wins (settings `cmdb_reconciliation`). A CI missing for longer than its connector's `retire_after_days` (default 14)
is proposed for retirement under CMDB → Proposed for retirement, where a person retires it; Kernel never retires or
deletes CIs by itself ([docs/connectors/README.md](docs/connectors/README.md)).

**Relationships and impact**: CIs and services are connected by typed relationships (runs on, depends on, uses
database, connects to, contains, part of service). The CI page shows what is affected if it is down, up to the
business services, and what it depends on; walks are bounded (10 levels, 500 nodes) and say when the picture is
incomplete. Connectors report relationships with `POST /api/ci-relationships/sync` and own what they report; manual
relationships survive every sync. CI groups collect CIs by hand or by rules (tag, type, team, attribute…).

**Problems on CIs**: problems and known errors link to the CIs and services they affect. The problem shows the
services reached through the CMDB and suggests a higher impact when a critical service is affected; the CI page shows
its known errors with their workarounds – what the service desk needs during an incident. Incoming incidents and
events can name their CI (`ci`, or `ci_source_system` + `ci_source_id`; a service name that matches exactly one CI
also works), candidates group by CI, and reports show CI hotspots and records no problem explains yet.

**Incidents**: native incident management (INC000001…) next to links to incidents in other tools. Log an incident
with its affected CIs and Kernel shows the services it affects, suggests the impact and puts known errors with their
workarounds at the top. Incidents move new → in progress → on hold → resolved → closed; resolving needs a resolution
code, a major incident has stakeholder communication updates and needs a problem before it closes. Create a problem
from an incident in one click; when the problem is resolved, its open incidents can be resolved together. Unlinked
incidents feed the problem candidates per CI, and reports show MTTA, MTTR, reopen rate and incidents per CI.

**On call**: Kernel pages through the team's own paging tool rather than replacing it. Per team, an administrator
sets PagerDuty (Events API v2), Opsgenie, Grafana OnCall or a signed webhook (SMS gateways, ntfy…), with write-only
credentials, and a rule: which priorities (P1 and P2 by default), major incidents, services and business or out of
hours. A matching incident triggers a page (the incident ref is the dedup key), responding in Kernel acknowledges it
and resolving resolves it; the tool's webhook reports who acknowledged, which becomes the incident's first response
for its SLA. Pages go through an outbox delivered outside any transaction, are retried and then reported to the team
lead, and every page is audited and listed on the incident. Who is on call comes from PagerDuty or Opsgenie (cached a
minute; a tool that cannot be reached says so) and shows on the team, the incident and the assign field. A team
without a tool can use a built-in weekly rotation with shifts that people take; it notifies in Kernel and does not
escalate or phone anyone. API: `/api/on-call`, `/api/teams/:id/paging`, `/api/teams/:id/rotation`,
`/api/paging/:id/inbound`; MCP: `get_on_call`.

**Major incidents**: declaring one is a single action that names the incident lead (you by default), an optional
communications lead and the bridge (meeting link or phone). The incident then shows who leads, where to talk, how long
it has run and when the next stakeholder update is due (every 30 minutes for P1 by default; the lead can change it).
Posting an update restarts the countdown, and an overdue update shows in the list and on My work and notifies the
communications lead. The same outage reported again is suggested as a related incident and linked in one click;
related incidents are resolved with the major incident unless someone unticks them, each with its own history entry.
A timeline view lists the key moments (anyone can mark a note) and exports as Markdown for the post-incident review.
With affected services, the status page gets a draft that a person posts. Resolving asks who runs the review, and by
when. API: `POST/PATCH /api/incidents/:ref/major`, `/communications`, `/children`, `/timeline`; MCP: `declare_major`,
`set_major_roles`, `post_communication`, `link_child_incident`, `get_incident_timeline`, `mark_key_moment` and the
prompt `lead_major_incident`.

**Post-incident reviews**: resolving a major incident schedules a short, blameless review (owner: the lead unless
someone else is named; due in five working days); any other incident can have one too. Opened for the first time, it
is filled in with the timeline and the impact Kernel knows (duration, services, CIs, people, related incidents, SLA,
changes shortly before, alerts), under a guided template: what happened, impact, what went well, what was hard, where
we were lucky. Contributing factors become problems in one click (the problem says it came from the review), follow-ups
become actions with an owner and a date, and the lessons become a draft knowledge article. With AI routed for it, a
button flags blameful wording (a hint only). A major incident closes once its review is published, or waived by a
manager with a reason (settings `major_incident.review_required`, on by default). Learn → *Post-incident reviews*
lists them all (due with overdue first, published, waived; by owner and team), with a menu badge for overdue reviews
of yours or your teams; the process map has the step between incident and problem. My work lists the reviews you own,
reports show the share of major incidents with a published review and the time to it, and the review exports as
Markdown or prints. API: `/api/incidents/:ref/review` (+ `/items`, `/publish`, `/waive`, `/article`, `/export.md`);
MCP: `get_review`, `create_review`, `update_review`, `add_review_item`, `review_factor_to_problem`,
`review_follow_up_to_action`, `review_follow_up_to_improvement`, `publish_review`, `waive_review` and the prompt
`draft_post_incident_review`.

**Continual improvement register**: Improve → *Improvements* collects improvements (`IMP000012`) from post-incident
reviews (a follow-up or gap becomes an improvement instead of an action), resolved or closed problems ("lessons
learned"), service reports ("Suggest an improvement", with the service and period filled in) and anyone's idea. Each
has a value and an effort (1–5), an owner, a service, and goes idea → approved → in progress → done, or rejected with a
reason; a problem manager approves and rejects, and done needs the benefit it brought. The list has saved views and
bulk actions, the board shows a Kanban by status (dragging a card changes its status with the API's rules; on a phone
each card has a move menu), and the value/effort matrix puts quick wins top left. An improvement links the changes,
problems and actions that carry it out, and can watch a dashboard KPI: its page shows that tile's trend. Restricted and
confidential sources make restricted and confidential improvements. Guided mode shows the continual improvement model
in four lines. API: `/api/improvements` (+ `/:ref/transition`, `/links`, `/comments`), `/api/problems/:ref/improvement`;
MCP: `list_improvements`, `get_improvement`, `create_improvement`, `update_improvement`, `transition_improvement`.
**Service requests** (an optional module, off until an administrator turns it on): Respond → *Service requests* keeps
what people ask for ("a new account", "access to a system", "a new VM") out of incident numbers. Managers keep a
catalogue under Administration: per service, a short form (at most 10 fields: text, choice, person, CI, date), who
approves (nobody, the requester's manager, the service owner or a team) and the fulfilment tasks in order, each for a
team. A request (`REQ000012`) is logged for a person, waits for its approver (by link from email or chat too, never by
an agent), then its tasks open one after the other in the teams' queues and My work; the last one fulfils it. The
item's SLA runs from submission to fulfilment and pauses while the request waits for approval; the dashboard gets a
*Requests fulfilled* tile. API: `/api/request-items`, `/api/requests` (+ `/:ref/approval`, `/transition`,
`/tasks/:id/complete`, `/links`, `/comments`); MCP: `list_request_items`, `list_requests`, `get_request`,
`create_request`, `update_request`, `transition_request` (cancel only), `complete_request_task`.
Viewers stay strictly read-only (auditors, stakeholders): end users report incidents through the service desk or,
later, the self-service portal (#45), not with a viewer account.

**How it all fits together**: the guide page shows the flow event → incident → problem → known error → change →
resolved with live counts from your data, scenario walkthroughs and a glossary of ITIL terms (also as hover hints on
form fields). Every record's guide panel ends with the hand-over to the next practice – "Ready to fix? Raise a
change", "A known error matches: link it", "Recurring? Create a problem" – and the dashboard shows gentle health tips
for the week. Agents get the same through MCP (`get_process_map`, `get_health_tips`, `next_steps.handover`).

**Keep it simple**: a first-run setup wizard (administrators) chooses the modules, the support hours, a first
monitoring source and optional example data – every step can be skipped and run again. Incidents, changes, events,
the CMDB and service levels are modules that can be switched off under Administration: they disappear from menus,
the API (404), MCP, search and reports, and nothing is deleted. Forms ask for the essentials first, with the rest
behind "More details"; templates prefill new incidents and problems. See `docs/ux-guidelines.md`.

**Notifications**: everything that concerns you – assignments, approvals waiting for you, decisions on what you
requested, SLA warnings and breaches, major incidents, updates on what you watch – appears under Notifications (the
bell). Each person chooses what also reaches them by email (instant or a daily digest at 07:00) or a personal Slack
or Teams webhook; defaults are quiet. Every email has a one-click unsubscribe link. Email needs `SMTP_URL` (and
optionally `KERNEL_MAIL_FROM`) in `.env`, e.g. `SMTP_URL=smtp://user:password@smtp.example.com:587`.

**Service levels**: SLAs set response and resolution targets per priority in business time, on a calendar evaluated
in its own time zone (24/7, or office hours with Swedish public holidays, plus extra closed days). One default SLA
works out of the box; a service can have its own, and an incident gets the SLA of its most critical service through
the CMDB. The clock pauses while an incident is on hold and between resolved and a reopen; warnings at 75 % and
breaches are recorded once, shown on the incident and in the list ("breaching soon": `?breaching_within=60`), and
reports show compliance per priority, service and team. Services can be published in the service catalogue with a
plain description and how to get help.

**Changes**: change enablement with standard (pre-approved templates), normal and emergency changes. Risk is assessed
from the most critical CI or service the change affects through the CMDB; the change authority (problem managers and
administrators) approves in the web UI – one approval for low and medium risk, two for high, never the requester's
own. Plans are locked once a change is submitted. The schedule shows collisions on the same CI and change freezes,
which block normal changes unless the change authority overrides with a reason. A problem raises a change for its
fix in one click; incidents on a CI shortly after a change on it or on what it depends on are flagged as possibly
change-related. Deployment pipelines register standard changes with `POST /api/changes/register` (integration token).

**Events from monitoring**: create an event source under Events → Sources (administrators). Each source gets its
own URL (`/api/event-hooks/<id>`) and token, shown once. Events are deduplicated into alerts per source, CI and check;
a clear closes the alert, flapping reopens the same alert, and replayed or out-of-order events never move an alert
backwards. Event rules (allowlisted conditions: severity, source, check, CI type, environment, criticality, repeat
count) open incidents, grouped per service, CI or rule and capped per hour, so an alert storm becomes one incident.
Incidents can auto-resolve once all their alerts stayed clear for a hold-down period. Maintenance windows on a CI,
a service (with what it depends on) or a CI group suppress alerts. Raw events are kept 14 days, daily counts longer;
payloads are never stored. Alerts that never became incidents feed the problem candidates.

| Tool | Source kind | Setup |
|---|---|---|
| Prometheus Alertmanager | `alertmanager` | `webhook_configs: - url: https://kernel…/api/event-hooks/<id>` with `http_config: authorization: { credentials: <token> }` |
| Uptime Kuma | `uptime_kuma` | Notification type Webhook, body "Preset – application/json", Additional Headers `{"Authorization": "Bearer <token>"}` |
| Azure Monitor | `azure_monitor` | Action group → Webhook with the common alert schema enabled, URL `…/api/event-hooks/<id>?token=<token>`; set the source's CMDB source system to the one your Azure CIs use (resource ids) |
| OP5 / Naemon | `op5` | A notification command that posts `{"host_name","service_description","state","output","notification_type","timestamp"}` with `X-Kernel-Token` |
| Anything else | `generic` | `{"events": [{"check","severity","host" or "ci","message","occurred_at"}]}`; optionally signed (Standard Webhooks) |

Send the token in a header wherever the tool allows it. The `?token=` form is only for senders that cannot set
headers (Azure action groups): Kernel redacts it from logs and traces, but proxies and the sender's own configuration
may keep it, so rotate those tokens regularly (the source list shows each token's age).

Scripts and agents can also report events with a token (`POST /api/events`) or the MCP tool `report_event`.

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
| `KERNEL_REPORTING_DB_PASSWORD` | – | Create the read-only role `kernel_reporting` for Power BI or Grafana: it reads the views in the `reporting` schema (no free text, no personal data, no restricted records) and nothing else; see [docs/reporting.md](docs/reporting.md) |
| `KERNEL_SECRET_KEY` | – | Encrypts stored secrets at rest (≥ 32 random characters); required for webhooks |
| `KERNEL_SECRET_KEYS`, `KERNEL_SECRET_KEY_ID` | – | More keys (`id:secret,…`) and the active one, for key rotation; see [docs/key-rotation.md](docs/key-rotation.md) |
| `KERNEL_LIVE_PER_USER`, `KERNEL_LIVE_TOTAL` | 6, 1000 | Live update streams per user and in total; see [docs/live-updates.md](docs/live-updates.md) |
| `KERNEL_OUTBOUND_ALLOW` | – | CIDRs/addresses on private networks that webhooks may reach (loopback, link-local and metadata addresses are always blocked) |
| `KERNEL_WEBHOOK_RETENTION_DAYS` | `30` | Successful deliveries are deleted after this many days, failed after three times as long |
| `KERNEL_SESSION_IDLE_HOURS` | `12` | Sessions unused for this long expire (absolute lifetime: `KERNEL_SESSION_DAYS`) |
| `KERNEL_HIBP_CHECK` | `false` | Also check new passwords against Have I Been Pwned (k-anonymity; only a hash prefix leaves Kernel) |
| `PORT` | `8080` | Listen port inside the container |

To deploy to the test server, merge to `main`, wait for CI's **Publish signed image** job and run
`scripts/deploy.sh`. It updates `~/kernel` on `dockerhost` (a clone using a read-only deploy key), pulls the image CI
built for that commit, verifies its Sigstore signature and waits until the app is healthy. `scripts/deploy.sh --build
<branch>` builds a branch on the server instead. See [docs/security-checks.md](docs/security-checks.md#signed-images-and-deployment).

`GET /healthz` checks the app and its database connection, for container health checks and Kubernetes probes.

## Security

- Strict Content Security Policy (no inline or eval scripts, no framing), cross-origin isolation (COOP, COEP,
  CORP), HSTS, `nosniff`, a restrictive `Permissions-Policy`, `Cache-Control: no-store` on API responses and a
  256 kB request body limit.
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
- **Security events** (sign-ins and failures, lock-outs, denied requests, invalid tokens, a token used from a new
  address, role and credential changes, exports and reveals, CSP reports, rate limits, invalid webhook signatures,
  blocked outbound requests): one line each in the `kernel.security` log stream and a row kept for a year.
  Administration → Security events; MCP `query_security_events`. Detection rules (many failed sign-ins or denials,
  bulk exports, a sign-in from a new country, a new administrator, changed credentials) raise alerts in Kernel's own
  event management, open a restricted security incident and notify administrators. See [docs/security-events.md](docs/security-events.md).
- With `KERNEL_APP_DB_PASSWORD` the app runs as a least-privilege PostgreSQL role without DDL rights.
- With `KERNEL_REPORTING_DB_PASSWORD`, BI tools read the `reporting` views as a role that can read nothing else; the
  views hold no free text or personal data and leave restricted records out ([docs/reporting.md](docs/reporting.md)).
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
`review_candidates`, `problem_review_board`, `triage_incident`, `lead_major_incident`, `draft_post_incident_review`. Resources: `kernel://guides/<id>` and `kernel://problems/{ref}`. They let Claude facilitate the analysis or review with you and record the
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
`npm run demo:reset` gives a fresh, current demo: it drops and recreates the database in `DATABASE_URL` (only a name
ending in `_demo`; anything else is refused), migrates it and seeds it. `npm run seed:demo -w server` seeds an
**empty** database without dropping it. The demo is one connected story across every practice, the *Webshop*: its
CIs from service to VM, an SLA, two teams, monitoring events that opened an incident, a change two hours earlier on the
payment gateway flagged as the likely cause, a major incident with a lead, a bridge, updates (the next one due in ten
minutes), two related incidents and a status page entry, the problem behind it with a 5 Whys analysis, a known error
and its article, follow-up actions (one overdue), an earlier major incident with a published post-incident review
(one of its gaps became an improvement), a continual improvement register with ideas in every stage,
contacts and organisations, maintenance next week and a change waiting for approval, plus a quarter of everyday
incidents and changes for the reports. Dates are relative to the time of seeding. Everything goes through the service
layer, so CI runs the seed against a fresh database and a change that breaks it fails the build. Demo users have the
password `demo-password` (admin, anna as problem manager, erik, sara and jonas as analysts, lena as viewer).

Schema changes go in a new numbered file in `server/migrations/`.

Integration tests (`server/test/integration/`) start Kernel against `TEST_DATABASE_URL` and exercise the REST API and the
MCP server through the official MCP client. CI (`.github/workflows/ci.yml`) runs typecheck, all tests, the build and a
Docker image build on every push and pull request.
