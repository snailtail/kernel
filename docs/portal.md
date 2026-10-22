# Self-service portal

The portal (`/portal`) is the front door for people outside IT. They report something that does not work, follow
what they reported or asked for, answer questions from IT and say whether a fix worked, without knowing ITIL or
Kernel's own views. It is plain language, mobile first, and works with a keyboard and a screen reader.

It is a module (Administration → Modules → **Self-service portal**) and **off by default**. While it is off, `/portal`
and everything under `/api/portal/` answer 404. Turn it off again at any time; nothing is deleted.

## Who can sign in

A portal identity is a **person** in the directory (People), never a Kernel user. There is no sign-up: someone who is
not in People cannot use the portal. Two ways in:

- **Single sign-on**, if it is set up (Administration → Single sign-on). The portal uses the same provider and the
  same redirect URL; the provider's email address must belong to exactly one active person. Groups and roles do not
  matter here and no Kernel account is created. As for Kernel's own sign-in, an address the provider marks as not
  verified (`email_verified: false`) is refused.
- **A link by email**, if Kernel can send mail (`SMTP_URL`). The person enters their address and gets a link that
  works **once, for 15 minutes**. It is 256 random bits, of which Kernel stores only the SHA-256, and it is made when
  the mail is sent. Opening the link only shows a **Sign in** button; pressing it signs in (mail scanners open every
  link, so the GET changes nothing). Every request gets the same answer whether the address is known or not. Each
  address gets at most 5 links an hour (the rest are dropped quietly) and each IP address may ask 20 times an hour.
  Unknown addresses, used or expired links and dropped requests are security events.

A portal session lasts **8 hours**. Its cookie (`kernel_portal`, `HttpOnly`, `Secure` behind HTTPS, `SameSite=Lax`,
path `/api/portal`) is only ever read by the portal's own routes: it cannot open anything else under `/api/`, and a
Kernel session cannot open the portal. Changes need the same `X-Kernel-Request` header and origin check as Kernel's
own UI.

## What people see

Only their own: problems they reported (incidents where they are the **caller**) and requests made for them (where
they are the **requester**). For each, the reference, the title, where it stands in plain words (Received, Being
worked on, Waiting, Solved, Closed; for requests also Waiting for approval, Done, Not approved), and who handles it:
the team's name, or "IT service desk". Never a person's name, internal notes, categories, CIs, other people,
priorities or service-level details. A **restricted or confidential** record shows its reference and status only.

Of the history they see only the **replies written for them** and their own messages. Everything the portal shows is
built in one place, `forPortal` in `server/src/audience.ts`.

## Replying to the requester

On an incident with a caller, and on any service request, the note box has a choice: **Internal note** (the default)
or **Reply to …**. A reply shows in the portal and is mailed to the person, with the reply's text and a link to answer,
plus a one-click unsubscribe. On a restricted or confidential record a reply is refused: the person would only see the
status, so contact them directly. Replies are written by people (web UI or API); agents over MCP add internal notes
only.

What the person writes back ("Add information", or the comment on "Still a problem") becomes a comment marked as
theirs. It is scanned for secrets and personal data like all input, and agents get it under `untrusted_content`
marked `from_requester`.

## Reporting a problem

Three questions: what it is about (the person's organisation's services and the services in the catalogue, or
"I am not sure"), what is happening, and who is affected. The answer to the last one sets impact and urgency through
a fixed mapping, never chosen by the person:

| Who is affected | Impact | Urgency |
| --- | --- | --- |
| Just me | 3 | 2 |
| Me and some others | 2 | 2 |
| Many people, or everyone | 1 | 2 |

The incident is logged with the person as caller and `source: portal`, routed to the service's team as usual. While
they type, published knowledge articles **for end users** are suggested (internal articles never are).

## Solved: does it work?

When a reported problem is solved, the person is asked whether it works. **It works** closes it. **Still a problem**
reopens it, within 14 days of it being solved, and tells the people handling it. A major incident only records the
answer; it closes through its review.

## Reaching it from outside

Behind an access gateway such as Cloudflare Access, people outside cannot reach the portal until you either add an
Access **bypass** policy for `/portal`, `/portal/*`, `/api/portal/*` and the web app's static files (`/assets/*`), or
publish those paths on a **separate host name** (for example `help.example.com`) that routes only them. The portal
then authenticates people itself. Single sign-on from the portal also needs `/api/auth/sso/callback` reachable.
Mail links point at `KERNEL_PUBLIC_URL`.

## API

`/api/portal/*` is listed in the OpenAPI document under **Portal**. It is for the portal page, with the portal's own
session; Kernel tokens and sessions do not work there.
