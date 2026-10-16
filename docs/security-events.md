# Security events

Kernel records security events (OWASP A09:2025, issue #64) in two places:

- **The `kernel.security` log stream** – one structured line per event (`event.dataset: kernel.security`, with
  `event.action`, `event.outcome`, `event.severity`, `user.id`, `source.ip`, the token prefix, the target and a
  request id). With `KERNEL_LOG_FORMAT=ecs` it is ECS JSON for Filebeat or Elastic Agent, so a SIEM gets every event.
- **The `security_events` table** – read by **Administration → Security events**, `GET /api/security-events`
  (with `/summary` for the last 24 hours) and the MCP tool `query_security_events`. Administrators only
  (`security.read`). The application role can add and read rows but not change them; only retention deletes them.

## What is recorded

| Action | Outcome | When |
|---|---|---|
| `auth.login_failed` | failure | wrong password or second factor, or local sign-in refused because SSO is required |
| `session.login`, `session.logout` | success | every sign-in (password, passkey, SSO, Cloudflare Access) and sign-out |
| `session.account_locked` | failure | an account locked for 15 minutes after repeated failures |
| `auth.passkey_failed`, `auth.sso_failed`, `auth.sso_denied`, `auth.sso_step_up_refused` | failure / denied | passkey and SSO problems |
| `auth.step_up_failed` | failure | a wrong password or code when confirming a sensitive action |
| `auth.session_revoked` | success | a session signed out from Settings |
| `auth.token_invalid` | failure | a bearer token that is unknown, revoked or expired |
| `auth.token_new_address` | info (warning) | an API token used from an address it was never used from (not its very first use) |
| `authz.denied` | denied | any 403 (prompts such as "confirm it is you" are left out) |
| `authn.required` | denied (info) | a 401 without a session, except a signed-out browser asking who it is |
| `auth.throttled`, `api.rate_limited` | blocked | 429 responses |
| `webhook.signature_invalid` | denied | an event, dev platform or paging hook with an unknown token or invalid signature |
| `network.outbound_blocked` | blocked | the SSRF guard refused an outbound request (only the host is kept) |
| `web.csp_violation` | blocked | a browser's Content Security Policy report |
| `mcp.tool_call` | success / failure | MCP calls: the tool and the target ref, never the content. Successful reads go to the log stream only |
| `data.export` | success | the problems CSV report |
| `<entity>.<action>` | success | from the audit trail: users and roles, API tokens, settings, keys, webhooks, connectors, event and dev sources, AI providers, SSO, team paging and members, and on any record `reveal`, `export`, `erase`, `break_glass`, `redact_history` |

A role change records the old and the new role; a new administrator, a lock-out and a suspected cloned passkey are
raised to severity `minor` or `warning`. Other changes record which fields changed, never their values.

## Privacy and volume

- No credentials, cookies, request bodies or field values. A sign-in name that matches no account (often a password
  typed in the wrong box) is stored only as a keyed digest, as in the audit trail (ADR 0001).
- IP address, user agent and, behind a trusted proxy, Cloudflare's country code are kept with each event for
  `settings.privacy.security_event_days` (365 days by default), like the audit trail's `audit_context`. Both periods
  are set under **Retention** on the Security events page or `PUT /api/admin/privacy` (30 to 3650 days, step-up and a
  reason, audited).
- **Erasing a user** does not remove these: IP addresses and user agents stay, under legitimate interest (ADR 0001),
  until retention removes them. The erase dialog says so. The account's name is removed from security alerts.
- At most 30 rows a minute per action and caller are stored. The rest of that minute becomes **one summary row**
  (the latest event, with `detail.suppressed` = how many more it stands for), so a scanner cannot fill the table, the
  SIEM still sees every line, and the detection rules still count the full volume.

## Alerting

Every minute, built-in detection rules read the new security events and report what they find to Kernel's own event
management under the reserved source **`Kernel security`** (no event source, connector or API caller may use that
name). Counts weigh summary rows by `detail.suppressed`.

| Rule | Alerts when | Severity |
|---|---|---|
| Failed sign-ins | ≥ 10 failed sign-ins (password, second factor, passkey, SSO, step-up) in 10 minutes for one account, or from one address (with the number of accounts: password spraying) | minor, major at 5× |
| Denied requests | ≥ 20 denied requests or invalid tokens in 10 minutes from one token, user or address | minor, major at 5× |
| Exports | ≥ 5 exports in 60 minutes by one person, or one export of ≥ 1000 rows | minor |
| New country | a sign-in from a country the account has not signed in from before (needs Cloudflare's country header behind a trusted proxy; an account's first known country is not "new") | minor |
| New administrator | someone gets the admin role | minor |
| Credentials changed | keys, SSO, AI providers, connectors, webhooks, event or dev sources change | warning |

Thresholds, windows and switches are set on the Security events page (`GET/PUT /api/admin/security-alerting`, MCP
`get_security_alerting`; changes need step-up and a reason and are audited). A counting alert clears by itself once
its subject is back under the threshold; the others stay open until someone closes them.

- **Incidents.** The event rule **Security alerts** (added by the migration, first in order) turns minor and worse
  alerts into an incident, all grouped into one open incident per four hours, at most three an hour. A security
  incident is always in the **Security** category and **restricted** (ADR 0002) to the rule's team, whatever the rule
  says. **Choose the team** under Events → Rules (its team, or an active team named as its group). Until then no
  incident is opened, since a restricted incident without a team would be visible to no one; the alerts and the
  administrators' notices still come, and the security status and the Security events page say so.
  Security alerts only ever match rules that name their source, never a catch-all rule.
- **Notifications.** Every new or reopened security alert notifies all administrators (event `security_alert`, in
  the app and by email and chat if they have them).
- **Who sees them.** Security alerts name accounts and addresses, so they are left out of the alert list, bulk actions
  and problem candidates for everyone without `security.read` (administrators).
- **How long they stay.** Closed security alerts and their raw events follow `security_event_days`, not the event
  retention. An alert grouped into a security incident stays with that restricted incident. Erasing a user replaces
  the account's name in security alerts with "deleted user #id"; IP addresses in them stay until retention.
