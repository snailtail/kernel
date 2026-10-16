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
  `settings.privacy.security_event_days` (365 days), like the audit trail's `audit_context`.
- At most 30 rows a minute per action and caller are stored; beyond that only the log line is written, so a scanner
  cannot fill the table while the SIEM still sees the full volume.
