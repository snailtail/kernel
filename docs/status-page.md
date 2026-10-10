# Public status page

Kernel can publish a status page at `/status` (HTML) and `/api/public/status` (JSON). It is **off by default**
(Administration → Public status page).

What it shows:

- Only services a problem manager made public, under a **public name** and description. The internal service
  name, its CIs, hosts and teams are never shown.
- Each public service's **published** status. Setting a status internally changes nothing publicly. It changes
  only when someone publishes it, or posts a public update with a status.
- Public updates from the last 14 days. Updates can be retracted (with a reason, audited).

Nothing on the page is derived live from incidents, alerts or the CMDB. Kernel's suggestions stay on the internal
board.

The page needs no sign-in and reads no session. Only GET is allowed. The HTML has a strict CSP and no scripts.
Responses can be cached for 30 seconds and carry an ETag. The general per-client rate limit applies.

## Reaching it from outside

If Kernel sits behind an access gateway (for example Cloudflare Access in front of `kernel.monkynet.com`), the public
page is not reachable until you either:

- add an Access **bypass** policy for the paths `/status` and `/api/public/status` (and nothing else), or
- publish those two paths on a **separate host name** (for example `status.example.com`) that routes only them.

The internal status board (`/service-status` in the app) stays behind sign-in.

## Not yet

Email and webhook subscriptions to service status need outgoing mail (`SMTP_URL`). They will use double opt-in
(a signed confirmation link and a POST to confirm), an unsubscribe link in every message, and the outbound client
for webhooks.
