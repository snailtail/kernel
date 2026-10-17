# Approval links in email and chat

When something waits for a person's approval (a change waiting for authorisation, or a decision an AI agent asked
for over MCP), the email and the personal Slack or Teams message carry **Approve** and **Reject** links. The approver
can decide from the message without signing in. The links are meant for routine decisions only: emergency and
high-risk changes still need a signed-in approver.

## The token

- Each link carries an **action token**: 256 random bits, made when the message is sent. Kernel stores only its
  SHA-256 (`approval_links.token_hash`). The token is never logged, because the request log redacts `?token=`, and it
  never goes into the audit trail.
- A token is bound to **one approver**, **one approval** and a **fingerprint of what is to be decided**. For a
  change, the fingerprint covers the type, risk, plans, window and affected CIs. For an MCP request, it covers the
  request and the problem's last update.
- It is **single-use** and **expires** after 72 hours, or earlier at the approval's deadline: a change's planned
  start, or the 14 days after which an MCP request expires.
- It stops working as soon as:
  - the approval is decided elsewhere, in the web UI or through another link;
  - the change leaves authorisation (scheduled, rejected, cancelled);
  - what was asked changes, so the fingerprint no longer matches;
  - the approver is disabled or loses the permission to approve;
  - the approver decides with the same request's link from the other channel.
- A retried delivery sends a new link and revokes the one from the failed attempt.

**Forwarding the message forwards the decision.** The link is the credential: whoever has it can decide as the
approver until it is used or expires. Do not forward approval emails; set `link_max_risk` lower (or to `none`) where
that is not acceptable.

## Using a link

- **GET never changes anything.** Mail security scanners (Safe Links, Proofpoint, Mimecast) open every link in a
  message. GET shows a minimal page: the ref, title, risk, window and who asked (plain text), and a form with
  Approve or Reject and a comment. A comment is required to reject.
- **POST decides**, once. The form carries a token derived from the link token (HMAC). The browser's `Origin` must be
  Kernel's own. No cookie is read: the decision is made as the link's approver, even if someone else's session is
  in the browser. It goes through the same service as in the web UI, so segregation of duties and the approval
  count apply as usual.
- **High risk needs a sign-in.** For an emergency change, or a change whose risk is above `link_max_risk` in the
  `change_policy` setting (default `medium`, so high risk needs a sign-in; `none` turns links off for changes), the
  message says "sign in to decide" and carries no Approve or Reject link. A link sent before the risk was raised
  shows the same. An MCP request to accept or defer a risk (`risk_decision`) also needs a sign-in. Accounts that
  must change their password or set up required MFA are also sent to sign in.

## Traceability

- The decision is recorded as the approver, with channel `email_link` or `chat_link`, in the change's activity and
  in the audit trail. The audit trail gets an extra `decided_by_link` entry with the link's id, never the token. The
  client IP and user agent go in `audit_context`.
- Refused links are security events (`approval_link.refused`, with the reason). An unknown token, a wrong form token
  or a wrong origin is `denied`. A link that was used, expired, changed, decided or needs a sign-in is `info`, because
  mail scanners reopen links all the time.
- The endpoint is rate-limited per client address (120 a minute) and per token (10 per 10 minutes).
