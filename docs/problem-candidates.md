# Problem candidates

Problem candidates are things worth a problem record that nobody has logged yet. Kernel finds them with rules over
incidents, events, changes and the CMDB, and outside tools can report their own (#31). Each candidate says **which
rule** found it, **why** in one sentence, and shows the **evidence**: the records, the CIs involved and, for trends,
a value per day.

Open them under **Problem candidates** (`/candidates`), in the process map under *Problem → How problems are found*,
or over MCP with `list_problem_candidates`.

## What you can do with one

| Action | What happens |
|---|---|
| **Log problem** | A new problem, prefilled from the evidence: title, a description listing the reason and every record, the CIs, the service. Every record is linked (incidents both ways, alerts as events, changes as change links). Detection is *reactive* when incidents in the evidence already happened, otherwise *proactive*. |
| **Link to existing problem** | The same links and CIs, on a problem you already have. |
| **Dismiss** | Needs a reason; audited. Covers the evidence the candidate has now. It comes back only when **new** evidence is enough for the rule on its own (for trends: when a new alert or change joins). |
| **Snooze** | Needs a reason; audited. Hidden until the time you pick, whatever arrives meanwhile. |
| **Restore** | Under *Dismissed and snoozed*: undoes either. |

A candidate only counts records its reader may see: restricted incidents and changes are left out for everyone else
(row-level security), and text from them is never copied into a problem that more people can read.

## The rules

Problem managers change the thresholds and turn rules on or off under *How candidates are found* at the bottom of the
page (`PUT /api/candidates/rules/:rule`). Every change is audited with the values before and after.

### From incidents (reactive)

| Rule | Finds | Settings (default) | Tuning |
|---|---|---|---|
| `recurring_records` · Recurring records on a CI or service | Unlinked incidents and events (native, reported by other tools, and alerts without an incident) on the same CI or service. | `min_records` (5), `window_days` (7) | Raise `min_records` for noisy CIs; a longer window finds slower patterns. |
| `common_upstream` · Incidents sharing an underlying CI | Unlinked incidents on different CIs that all depend on the same CI, walking down the dependency graph. When several shared CIs explain the same incidents, the closest is shown. | `min_records` (3), `min_cis` (2), `window_days` (7), `max_depth` (3) | Lower `max_depth` if very shared CIs (a data centre, a network) show up; it needs relationships in the CMDB. |
| `major_without_problem` · Major incident resolved without a problem | A major incident resolved in the window that no problem explains, with its related incidents. Listed first. | `window_days` (30) | Rarely changed: every major incident deserves a problem or a reasoned dismissal. |
| `recurring_resolution` · Same category and resolution | Resolved incidents in one category with the same resolution code (fixed, workaround, no fault found). A workaround that keeps being applied is the classic sign. | `min_records` (4), `window_days` (30) | Keep categories meaningful; an "Other" category hides this signal. |

### Before it hurts (proactive)

| Rule | Finds | Settings (default) | Tuning |
|---|---|---|---|
| `flapping` · Flapping checks | A check that keeps clearing and firing again (Kernel reopens the same alert within the reopen window). | `min_flaps` (5), `window_days` (7) | Fix the check or its threshold, or find what makes it flap. |
| `rising_warnings` · Rising warnings on a CI | Warning and minor events on a CI in the last window compared with the one before, from the daily counts (kept after raw events are purged). Events during a maintenance window do not count. | `min_events` (10), `factor_percent` (200), `window_days` (7) | Raise `min_events` for chatty CIs; `factor_percent` 150 catches gentler growth. |
| `capacity_warnings` · Recurring capacity warnings | Disk, file system, memory, swap, heap, storage, quota and OOM alerts on the same CI (matched on the check name and message). | `min_firings` (3), `window_days` (30) | Use the words above in check names so they are recognised. |
| `self_clearing` · Alerts that clear themselves | A check that fires and clears on its own within minutes, unacknowledged and without an incident, again and again. | `min_firings` (5), `max_minutes` (30), `window_days` (14) | Short `max_minutes` for blips; such alerts are either noise to tune or a problem nobody sees. |
| `change_correlation` · Changes that fail or hurt | Changes on a CI that failed, were rolled back, or were followed by an incident on the CI within some hours. Changes already linked to a problem do not count. | `min_changes` (3), `min_percent` (50), `within_hours` (24), `window_days` (90) | Lower `within_hours` where incidents are frequent anyway. |
| `repeatedly_missing` · CIs that keep going missing | CIs that synced sources reported missing more than once: flaky discovery, or something that keeps disappearing. | `min_times` (2), `window_days` (90) | A CI is marked missing after the source missed it `missing_after` syncs in a row (CMDB reconciliation settings). |
| `eol_versions` · Versions at end of life | CIs whose synced `os`, or `engine`/`product` with `version`, matches a row in the end-of-life table whose date has passed or is within the warning time. | `warn_days` (180) | Keep the table current (below). |
| `single_point_of_failure` · Single points of failure | A CI that many services depend on, where something relies on it with no other CI of the same type related the same way. | `min_services` (3), `max_depth` (5) | Tag a clustered CI kept as one record `redundant`; model replicas and nodes as separate CIs. |
| `reported` · Reported by external analysis | Candidates from outside, e.g. an agent reading logs (`report_problem_candidate` over MCP, `POST /api/candidates/report`). Idempotent on source and the reporter's own key; secrets in the text are redacted; evidence at most 64 KB. | none | Give each finding a stable `external_key` so reporting it again updates it. |

## The end-of-life table

`eol_versions` compares CI attributes with a small table of product, version and end-of-life date. Kernel ships a few
well-known rows (Ubuntu, CentOS, RHEL, Debian, Windows Server, PostgreSQL) as a start; nothing is fetched from an outside
service. Problem managers add, change and remove rows under the rule (or `POST/PUT/DELETE /api/candidates/eol`,
`save_eol_version` over MCP); every change is audited.

A row matches a CI when its label equals *product version*, or continues with a dot or a space: the row
`PostgreSQL 13` matches `PostgreSQL 13` and `13.4`, not `130`; `Ubuntu 20.04` matches `Ubuntu 20.04.6 LTS`.

## Adding a rule

See `docs/api-conventions.md` (*Problem candidates*): a rule is a function that returns candidates with a
`finish(records)` giving the reason (or null when the evidence no longer meets the rule), plus a row in `RULES` with
its label, description, detection, section and settings. Add a positive, a negative and a dismissed test, demo data so
`demo:reset` shows it, and a line in this page.
