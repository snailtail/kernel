# Service reports and the dashboard (#54)

One picture per service for the service review, and a few KPIs across the practices. Everything is read through
row-level security (ADR 0002): a report or a tile shows what its reader may see, and managers are told when
restricted records are left out.

## Service report

`/services/:ref/report` (REST `GET /api/services/:ref/report?from=&to=`, MCP `get_service_report`): availability
within the SLA's service hours with planned maintenance subtracted, incidents by priority with resolution SLA and
MTTR, changes with their success rate, and open problems and known errors. The service's components (CIs that are
`member_of` it) count too.

- **Print** from the page, or download **Markdown** (`report.md`).
- **CSV** (`GET /api/reports/service.csv?service=&from=&to=`): one row per incident active in the period, change in
  it and problem open now. Text that a spreadsheet would read as a formula is prefixed with `'` (#69).

## Scheduled reports

The service's owner, or a manager, asks for the report by email every month or quarter (on the report page, or
`POST /api/report-schedules { service, frequency }`). A manager can also schedule an organisation's report
(`{ organisation_id, frequency }`): one mail covering every service the organisation uses.

- After a month or quarter ends, it is queued once per schedule (`report_deliveries` is unique on schedule and
  period), so a restart, a second replica or a worker running twice never sends it twice. Deliveries are claimed with
  a lease and retried a few times.
- A period that ended before the schedule was made is not sent; the first mail covers the period the schedule was
  made in.
- The mail is a short summary per service with a link, and the full report attached as Markdown. It is read as the
  recipient, but **restricted records are always left out**, since mail leaves Kernel's access control.
- Who may have it is checked again when sending: a former owner, a deactivated account or one without an email
  address is skipped.
- Recipients stop a schedule on the report page (`DELETE /api/report-schedules/:id`); managers can stop anyone's.

Mail needs `SMTP_URL` (see the notifications settings); without it deliveries fail with "Email is not configured".

## Dashboard KPIs

`/dashboard` starts with service KPIs (REST `GET /api/dashboard/kpis?period=month|week`, MCP `get_dashboard`), each
with its value, a trend over the last six periods (the current one, still running, drawn lighter), how it is
calculated and a link to the list behind it:

| Tile | Value | Trend |
| --- | --- | --- |
| Mean time to resolve | incidents resolved this period, logging to resolution; per priority below | per period |
| Resolved within SLA | share of incidents with a resolution target resolved by it | per period |
| Change success rate | completed changes that were successful; changes followed by an incident on their CIs within 24 h | per period |
| Recurring incidents | CIs and categories with 3+ incidents in 30 days, none linked to a problem | at each period's end |
| Problems resolved | problems resolved this period; known errors with a workaround | per period |
| Open major incidents | not yet resolved, now | declared per period |

Tiles of switched-off practices, and of practices the reader may not read, are left out. Which tiles show, and in
what order, is each person's own preference
(`dashboard_tiles`; unknown ids are ignored); there is no query language. `GET /api/dashboard` and MCP
`get_dashboard` keep the problem backlog summary; `get_dashboard` adds the KPIs as `kpis`.

A read-only reporting schema for Power BI or Grafana is not part of this; it is tracked in #150.
