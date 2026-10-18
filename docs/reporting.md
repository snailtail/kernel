# Reporting schema for Power BI and Grafana (#150)

Kernel's own reports and dashboard (see [service-reports.md](service-reports.md)) cover the service review. For
anything else, a BI tool can read a set of views in the `reporting` schema directly from PostgreSQL, as a role that
can read those views and nothing else.

## What the views hold, and what they don't

Refs, statuses, codes, priorities, timestamps, SLA results, categories, teams, SLAs, services and CIs. **No free
text and no personal data**: no titles, descriptions, notes, workarounds, reporters, callers, assignees, names of
people, email addresses or user ids. A test compares every column with an allowlist, so adding a column is a
deliberate decision.

- **Restricted records** (ADR 0002) are not in any view, and a link to one (an incident's problem) shows no ref.
  The views filter them out themselves, so it does not depend on row-level security or on anything the reader sets.
- **Confidential records** (#61) are included: what is confidential about them is their text, and no view has any.
  Their `classification` column says which they are.
- **Team-scoped practices are not applied.** The role is for BI over the whole operation: whoever has its password
  sees every record that is not restricted, whatever team it belongs to. Give the password only to people who may see
  that.

| View | One row per | Columns |
| --- | --- | --- |
| `reporting.incidents` | incident | `ref`, `status`, `priority`, `impact`, `urgency`, `category_id`, `category`, `team_id`, `team`, `source`, `is_major`, `resolution_code`, `classification`, `reopen_count`, `problem_ref`, `parent_ref`, `sla`, `created_at`, `responded_at`, `resolved_at`, `closed_at`, `major_declared_at`, `response_due_at`, `response_breached_at`, `resolution_due_at`, `resolution_breached_at`, `response_sla_met`, `resolution_sla_met`, `sla_paused_minutes`, `minutes_to_respond`, `minutes_to_resolve` |
| `reporting.problems` | problem | `ref`, `status`, `priority`, `impact`, `urgency`, `category_id`, `category`, `team_id`, `team`, `detection`, `is_major`, `closure_code`, `classification`, `has_workaround`, `workaround_effectiveness`, `ec_risk_level`, `created_at`, `known_error_at`, `resolved_at`, `closed_at`, `minutes_to_resolve` |
| `reporting.changes` | change | `ref`, `change_type`, `status`, `risk`, `outcome`, `source`, `team_id`, `team`, `classification`, `problem_ref`, `planned_start`, `planned_end`, `actual_start`, `actual_end`, `created_at`, `closed_at`, `minutes_to_implement` |
| `reporting.sla_events` | SLA warning or breach as it fired | `incident_ref`, `target` (`response`/`resolution`), `kind` (`warning`/`breach`), `fired_at` |
| `reporting.cis` | CI or service (`class`) | `ref`, `class`, `name`, `ci_type`, `status`, `environment`, `criticality`, `in_catalogue`, `sla`, `availability_target`, `created_at`, `missing_since` |
| `reporting.ci_relationships` | relationship between CIs | `from_ref`, `type` (e.g. `member_of`, `depends_on`), `to_ref` |
| `reporting.record_cis` | CI on an incident, problem or change | `record_type`, `record_ref`, `ci_ref` |

Notes on the columns:

- `response_sla_met` / `resolution_sla_met`: true when done by the target and never breached, false once breached,
  empty without a target or while still running. The dashboard's "Resolved within SLA" uses the same rule.
- `minutes_to_respond`, `minutes_to_resolve`, `minutes_to_implement` are wall-clock minutes (logging to response or
  resolution; actual start to actual end). SLA targets are in business minutes; `sla_paused_minutes` is the time on
  hold.
- To report per service, follow `reporting.record_cis` to the CI, then `reporting.ci_relationships` (`member_of`)
  to the service, as the service report does.

## Switching it on

1. Generate a password and set it in `.env`:

   ```sh
   echo "KERNEL_REPORTING_DB_PASSWORD=$(openssl rand -base64 30)" >> .env
   ```

2. Restart Kernel (`docker compose up -d`). On start it creates the role `kernel_reporting` (or
   `KERNEL_REPORTING_DB_USER`): it can log in, has `USAGE` on `reporting` and `SELECT` on its views, nothing in
   `public`, is not a superuser and does not bypass row-level security. Queries are stopped after 60 seconds. The
   password is stored as a SCRAM verifier only.
3. **Administration → Security status** shows "Reporting database role" as read-only.

To switch it off, remove the variable and restart: the role can no longer log in.

## Reaching the database

The Compose file does not publish PostgreSQL on the host. Publish it only where the BI tool runs, for example on the
LAN address in a `docker-compose.override.yml`:

```yaml
services:
  db:
    ports:
      - "192.0.2.10:5432:5432"   # the host's LAN address
```

The PostgreSQL container has no TLS of its own: the password never crosses the network (SCRAM), but the rows do.
Keep it on a trusted network or reach it through an SSH tunnel or VPN, and firewall the port to the BI hosts.

## Power BI

**Get data → PostgreSQL database**: server `host:5432`, database `kernel`, **Database** credentials with
`kernel_reporting` and the password. Choose the views under `reporting`. Import mode with a scheduled refresh is
enough for these volumes; DirectQuery also works. Power BI Service needs an on-premises data gateway that can reach
the database.

## Grafana

**Connections → Data sources → PostgreSQL**: host `host:5432`, database `kernel`, user `kernel_reporting`, TLS mode
`disable` (or `require` behind a TLS proxy). Example panel, incidents resolved per week and the share within SLA:

```sql
SELECT date_trunc('week', resolved_at) AS time,
       count(*) AS resolved,
       round(100.0 * count(*) FILTER (WHERE resolution_sla_met) / nullif(count(*) FILTER (WHERE resolution_due_at IS NOT NULL), 0), 1) AS within_sla_pct
FROM reporting.incidents
WHERE $__timeFilter(resolved_at)
GROUP BY 1
ORDER BY 1
```
