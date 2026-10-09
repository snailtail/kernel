# 2. Visibility and restricted records

Date: 2026-10-10 · Status: accepted · Issues: #53, #42, #45

## Context

Until now every staff member could see every problem, incident and change. Some records must not be widely seen:
security incidents, HR-related problems, a vulnerability before it is fixed. Larger organisations also want teams to
see mainly their own work. Hiding records is easy to get wrong. A filter added by hand to some of the ~130 queries
leaks through the others: a count, a search, a report, an export, a similar-problem suggestion or an MCP tool.

## Decision

**Visibility is enforced by PostgreSQL row-level security (RLS)**, not by application code.

- Kernel connects as a role without `BYPASSRLS` (`KERNEL_APP_DB_PASSWORD`, see the security status). `problems`,
  `incidents` and `changes` and their child tables have `FORCE ROW LEVEL SECURITY`. The policies call
  `kernel_can_see()` (119_visibility.sql).
- Every statement runs with the setting `kernel.viewer`. `db.ts` sets it on a connection whenever the borrower's
  viewer differs from the last one, and the raw pool is private to `db.ts` (a test forbids other access). Values:
  `system` (background work), `u:<id>:<role>:<team ids>:<scoped practices>:<flags>` (a person, built per request so
  a team change applies on the next request), or empty, which fails closed.
- Child tables (activity, links, CIs, people, votes, attachments, SLA events…) follow their record through
  `EXISTS` policies. A hidden record therefore also hides its history and links, and leaves the counts.
- Triggers that keep other tables in step (team renames, known-error articles, attachment clean-up) act as `system`
  for their own statements and then restore the viewer.

**Restricted records** (`restricted`, `restricted_teams`) are visible to:

- the assignee,
- the creator,
- members of the allowed teams,
- an administrator using *break-glass*.

Problem managers are not exempt. Need-to-know applies to them too. Their reports and dashboards show "some records
are restricted and not included" as a yes/no, never a count, so they know the numbers are incomplete.

**Break-glass** (`POST /api/records/:ref/break-glass`) is for administrators only, with step-up and a reason. It
opens one record for one hour. It is audited, the assignee, creator and the leads of its team and allowed teams are
notified, and active sessions are listed in the security status.

**Team scoping** per practice (`settings.visibility.team_scoped`) is off by default. When it is on, analysts and
viewers see their teams' work, work without a team, and their own records. Managers are not scoped.

**Categories** listed in `settings.visibility.restricted_categories` (e.g. "Security incident") start restricted.

**No existence oracle**:

- A hidden ref answers exactly like a ref that does not exist, on get, links, attachments and MCP.
- Links to Kernel records the viewer cannot see are hidden.
- Linking to a hidden ref gives the same 404 as linking to a missing one.

**Derived content**:

- A problem raised from a restricted incident, and a change raised from a restricted problem, are restricted the
  same way.
- Knowledge articles are never more visible than their problem, and restricted incidents cannot become articles.
- Attachments follow their record.
- Notifications go only to people who may see the record.
- Webhooks for restricted problems carry only the ref.
- Idempotent replays re-check visibility.

**AI**: requests through MCP carry the `noai` flag unless `ai_data.restricted_records` is on (default off). Agents
then never see restricted records, even when their user could.

Changing a record's visibility needs a reason and is audited. So are the settings.

## Consequences

- One rule covers every surface, including future ones. `visibility.test.ts` is a leak harness: it seeds restricted
  records whose text carries a random marker, then calls every GET route in the OpenAPI document and every read-only
  MCP tool and resource as people who may not see them.
- Tests run Kernel as the least-privilege role, as production does. The few tamper tests use an owner connection.
- A superuser or the schema owner bypasses RLS, as they bypass everything else. Database access remains a
  trust boundary (see the security status).
- Performance: unrestricted, unscoped rows return early from the policy function. Restricted rows have partial
  indexes. Team ids travel in the viewer string, so policies need no per-row membership lookup. If very large
  installations need it, the function can be inlined into the policy.
- Organisation scoping for customer contacts (the portal, #45) builds on the same mechanism and is not part of this
  change.
