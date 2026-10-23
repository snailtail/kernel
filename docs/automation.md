# Automation rules

Automation rules (`/rules`, menu **Directory → Automation rules**) do the small routine work of a service desk:
route new work, raise a VIP's priority, remind people, and tidy up. A rule is one sentence:

> **When** an incident is created, **if** service is Payroll, **then** assign to team HR-Systems.

Rules are **declarative only**. A rule is JSON with a trigger, conditions and actions. Each part is checked against
an allowlist for its record kind. Nothing in a rule is evaluated as an expression, script, regex or template.

Event rules (monitoring alerts → incidents) and candidate rules (patterns → problem candidates) are separate
kinds of rules with their own pages. The rules page links to both.

## Who does what

| | Viewer | Analyst | Problem manager / admin |
|---|---|---|---|
| See rules, their runs and dry runs | ✓ | ✓ | ✓ |
| Propose a rule (it lands **disabled**) | | ✓ | ✓ |
| Write, change, enable, disable, remove | | | ✓ |

- **Only a person signed in to Kernel enables a rule.** An API token can write a rule but not enable it. An AI agent
  over MCP can only propose one, and the proposal shows as *Proposed by agent* until a manager enables it.
- Whoever enables a rule becomes its **owner** and is told if the safety limit turns it off.
- Every change to a rule (create, update, enable, disable, delete, propose, tripped) is in the audit trail with the
  values before and after.

## How a rule runs

- A change to an incident, problem, change or request queues a run for each enabled rule whose trigger matches. The
  run is queued in the same transaction as the change (an outbox, `rule_runs`). A worker runs it **after commit**
  with a lease, usually within a second. A rule can never make a person's save fail, and a rule that fails is only
  logged.
- A rule acts as **itself** (`rule:<id>`, *Rule 'Payroll routing'* in histories). It goes through the same service
  functions as a person, so the same validation, SLA recalculation, team queues, notifications and audit trail
  apply. It has an **analyst's permissions**: a rule can never do more than an analyst.
- It sees every record (the system viewer), so a rule works on restricted records too. What it tells people is still
  limited by what *they* may see (see Notifications below).
- The conditions are checked when the run starts, against the record as it is then.

## Triggers

| Trigger | Fires when | Kinds |
|---|---|---|
| `created` | the record is created | all |
| `field_changed` (`field`) | priority, category, team or assignee changes | incidents and problems (all four), changes (team, assignee), requests (priority) |
| `status_changed` (`to`, optional) | it moves to that status (any status without `to`) | all |
| `in_status_for` (`status`, `hours`) | it has been in the status for that long: 15 minutes (0.25) to a year | all |
| `due_in` (`hours`) | a follow-up action on the record is due within that long (1 to 720 hours) | incidents, problems, changes, requests |

**Time triggers** are found by a scan every minute and queued into the same `rule_runs`.
- Each run carries a **window key**: the moment the record entered the status (`in:<status>:<time>`) or the action and
  its due date (`due:<action>:<date>`). A unique index keeps it to **one run per record and window**, so a reminder or
  note is never repeated, even with several replicas or a second scan.
- When the record leaves the status and comes back, that is a new window.
- One replica scans at a time (an advisory lock), and each rule queues at most 200 runs per scan.
- A time run checks again before it acts. If the record is no longer in the status, or the action is done or its due
  date moved, the run is skipped.

## Conditions

All conditions must hold, and a rule may have none. Only structured fields can be checked, never free text:

| Field | Values | Operators | Kinds |
|---|---|---|---|
| `service` | service ref (`SVC…`), found through the CMDB from the record's CIs, as in impact analysis | is, is not, is one of, is empty | all (requests: the catalogue item's service) |
| `ci` | CI ref | is, is not, is one of, is empty | incidents, problems, changes |
| `priority` | 1–5 | is, is not, is one of, `lt` (more urgent), `gt` (less urgent) | incidents, problems, requests |
| `category`, `team`, `assignee` | ids | is, is not, is one of, is empty | where the kind has them |
| `status`, `source` | the kind's values | is, is not, is one of | all / incidents, changes |
| `caller_vip` | true / false | is | incidents, requests |
| `is_major` | true / false | is | incidents, problems |
| `requester_reopened` | true / false: the caller once said "still a problem" in the portal | is | incidents |

## Actions

| Action | Does | Notes |
|---|---|---|
| `set_field` | sets priority, category, team or assignee | Never classification, restriction or text. On incidents and problems a priority becomes impact and urgency (P1 = 1/1, P2 = 1/2, P3 = 2/2, P4 = 2/3, P5 = 3/3). |
| `assign_team` | moves it to a team | Its queue is told, as when a person does it. |
| `add_comment` | adds an **internal note** in the rule author's fixed words | Never a reply to the requester. |
| `notify` | in-app (and per the person's settings, email/chat) notice | Named people and teams, and `roles`: `assignee`, `team_lead` (the record team's leads), `approvers` (requests), `owner` (the due action's owner, `due_in` only). |
| `transition` | `closed` from resolved, `in_progress` from on hold | Incidents only. Closing follows the normal checks (a major incident needs its problem and review). |
| `webhook` | sends `rule.matched` to an outgoing webhook an administrator has set up | Signed, retried and SSRF-checked like every webhook delivery. Never a URL of its own. |

A rule has 1 to 10 actions. They run one by one, and one failing does not stop the others. The run log shows what
each action did.

### What leaves Kernel

- **Notifications** reach only people who may see the record. They carry the ref, the title and one line saying why
  (*Rule 'X': resolved for 5 days*), never the record's text.
- **Webhook** payloads (`event: rule.matched`) carry the rule, the trigger and the record's kind, ref, title, status,
  priority and URL. A **restricted** or **confidential** record leaves only as its ref, with `restricted` and
  `classification` set and no title: a webhook usually ends up in a chat channel.

## Loops and limits

| Guard | Limit | What happens |
|---|---|---|
| Chain depth | A person's change, then at most **3 rules in a row**, each set off by the one before | The fourth is skipped, with *the loop guard* in the run log and the record's history |
| Refire | The same rule fires **at most once per record in 10 minutes** (not for time triggers, which have windows) | Skipped, with the reason |
| Circuit breaker | More than **50 actions in a minute** for one rule | The rule is **turned off** (`tripped_at`), audited, and its owner is notified; enabling it again clears the trip |

So A → B → A stops on the second A, and a chain of four different rules stops at the fourth.

## Dry run

**Try it** (`POST /api/rules/dry-run`, MCP `dry_run_rule`) checks a rule's conditions against the records of its kind
updated in the last 30 days, as they are now. It reports how many matched and the 5 latest. It reads as the person
asking, so restricted records they cannot see are not counted. Nothing changes and no action runs.

## Recommended rules

Four rules ship **disabled**. Each turns on with one click on the rules page:

- **Close resolved incidents after 5 days**: not when the caller said "still a problem" in the portal, and not
  for major incidents (a person closes those after the review).
- **Remind the owner of actions due tomorrow**: problem follow-up actions, once per action and due date (a copy of
  the rule on another kind reminds about that kind's actions).
- **Escalate an unassigned P1 to the team lead after 15 minutes**: a P1 still new and unassigned.
- **Remind the approver of a request after 2 days**: a request still waiting for approval.

They are ordinary rules: change them, or remove them.

## Logs

- **On the record:** what a rule did is in its activity and history, named after the rule ("via an automation
  rule").
- **On the rule:** the latest runs with their result (*Ran*, *Stopped*, *Failed*) and what each action did, plus
  counts for the last 30 days. Runs on records the reader cannot see are hidden (row-level security).
- **Retention:** runs that did not match are kept for 7 days, the rest for a year.

## API and MCP

| REST | MCP | |
|---|---|---|
| `GET /api/rules` | `list_rules` | rules with a sentence and 30-day counts, the other rule kinds, and (for managers) the webhooks by name |
| `GET /api/rules/:id` | `get_rule` | one rule with its latest runs |
| `POST /api/rules/dry-run` | `dry_run_rule` | a dry run of a rule id or a draft |
| `POST /api/rules/proposals` | `propose_rule` | a proposal, disabled |
| `POST /api/rules`, `PUT /api/rules/:id` | | write (managers) |
| `PUT /api/rules/:id/enabled` | | enable or disable (a signed-in person) |
| `DELETE /api/rules/:id` | | remove |
