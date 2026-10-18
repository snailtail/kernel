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

- add an Access **bypass** policy for the paths `/status`, `/status/*` (sign-up, confirmation and unsubscribe) and
  `/api/public/status` (and nothing else), or
- publish those paths on a **separate host name** (for example `status.example.com`) that routes only them.

Mail links point at `KERNEL_PUBLIC_URL`, so set it to the address people outside can reach.

The internal status board (`/service-status` in the app) stays behind sign-in.

## Retracting an update

A problem manager retracts a published update with `POST /api/status/updates/:id/retract` and `{ "reason": "…" }` in
the body. The update leaves the public page, mail that has not gone out yet is stopped, and the reason is audited.
The reason travels in the body because query strings end up in proxy, gateway and request logs. The old
`DELETE /api/status/updates/:id?reason=…` answers 400 with a pointer for one release.

## Subscriptions

Status updates reach four kinds of recipients, and each gets something different.

| Who | How they subscribe | What they get |
| --- | --- | --- |
| Staff (Kernel users) | **Follow** on a service on the status board (or MCP `follow_service`) | Every update on the service, internal or public, in the bell and by email or chat according to their own notification settings (event "A status update on a service I follow"). |
| People outside | The form on the public page, for public services only | Published updates by email. |
| Organisation contacts | A problem manager ticks **Status contact** on a person in an organisation that uses the service | Published updates by email. |
| Systems | An administrator adds a webhook with the event `status.published` (Administration → Webhooks), optionally for some services | Published updates as JSON, Slack or Teams, signed like every Kernel webhook (Standard Webhooks plus `X-Kernel-Signature`). |

Staff following a service also hear about internal updates. People outside, contacts and webhooks hear about an update
only when a problem manager **publishes** it. Kernel never sends anything outside on its own.

### What people outside receive

Only the published text: the service's **public name**, the phase, the published status and the message, with the
page title and time. They never get the internal service name, CIs, the incident's ref or title, or who wrote the
update. All of this is built in one place (`forOutside` in `server/src/audience.ts`). A major incident's status
proposal also names services by their public names, so a draft that is published unchanged reveals nothing internal.

### Double opt-in for people outside

1. Someone enters an address on `/status` and picks services (none means all public services).
2. The answer is always the same ("If the address can receive mail, a confirmation is on its way"), so nobody can tell
   whether an address is already subscribed.
3. Kernel sends a confirmation mail with a single-use link that expires in 48 hours. Only a hash of the token is
   stored. Opening the link (`GET`) only shows what would be confirmed, because mail scanners open every link. The
   button on that page (`POST`) confirms it.
4. Unconfirmed sign-ups are deleted after seven days.

Sign-up is rate limited: 10 per hour per client, and 3 confirmation mails per address per day. Beyond the address
limit the answer stays the same and nothing is sent.

### Unsubscribing

Every mail to someone outside has a signed one-click unsubscribe link (RFC 8058, `List-Unsubscribe` and
`List-Unsubscribe-Post`). As with confirmation, `GET` only asks and `POST` acts. A subscriber who unsubscribes is
deleted. A contact who unsubscribes stops being a status contact, and the change is audited. The links are signed with
the key ring, so they keep working after a key rotation.

### The communication log

Each major incident shows a **Communication log**: for every status update on it, which organisation contacts were
told, when the mail went out (or whether it was queued, failed or not sent), and how many subscribers got it. Use it in
the post-incident review. Contacts are stored by id, so erasing a person also removes their name from the log.
Delivery rows for subscribers are kept for 90 days. MCP `get_incident` shows the organisations and counts, without
names or addresses.

Subscriptions need outgoing mail (`SMTP_URL`). Without it, the public page shows no sign-up form.
