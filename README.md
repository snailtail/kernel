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
- Every change is written to the activity log of the problem.

**Linked records** connect a problem to records in other systems: *incidents* (reactive), *events* (proactive),
*changes* (implementing the fix) and other *problems*. Each link can have the source system name and a URL.

### Roles

| Role | Can |
| --- | --- |
| Viewer | Read everything |
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
| `PORT` | `8080` | Listen port inside the container |

To deploy to the test server, push your commits and run `scripts/deploy.sh`. It pulls `main` in `~/kernel` on
`dockerhost` (a clone using a read-only deploy key), rebuilds the containers and waits until the app is healthy.

`GET /healthz` checks the app and its database connection, for container health checks and Kubernetes probes.

## MCP

The MCP endpoint is `http://<host>:8080/mcp` (Streamable HTTP, stateless). Clients authenticate with a personal
API token, created under **Settings → API tokens & MCP**, and act as that user with that user's role.

```sh
claude mcp add --transport http kernel http://dockerhost:8080/mcp \
  --header "Authorization: Bearer krn_..."
```

Tools: `whoami`, `list_reference_data`, `search_problems`, `get_problem`, `search_known_errors`, `get_dashboard`,
`create_problem`, `update_problem`, `transition_problem`, `add_comment`, `link_record`, `unlink_record`.

## REST API

All endpoints are under `/api` and accept either the session cookie (web UI) or `Authorization: Bearer krn_...`.
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
| GET | `/api/dashboard` | Backlog summary |

## Development

Requires Node.js 24 and PostgreSQL.

```sh
npm install
DATABASE_URL=postgres://kernel:kernel@localhost:5432/kernel npm run dev:server   # API on :8080
npm run dev:web                                                                   # UI on :5173, proxies /api and /mcp
npm test
npm run typecheck
```

Layout: `server/` (Fastify, TypeScript, PostgreSQL, MCP SDK) and `web/` (React, Vite). Business rules live in
`server/src/workflow.ts` and `server/src/problems.ts`, which both the REST API and the MCP server use.
Schema changes go in a new numbered file in `server/migrations/`.
