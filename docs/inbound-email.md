# Inbound email

A support mailbox can feed Kernel: new mail becomes an incident, and a reply to an incident becomes a comment. A
mailbox is a connector (**Administration → Connectors → + Connector**), so it uses the same encrypted, write-only
credentials, schedule, lease, run log and **Test** button as the CMDB connectors. It needs the incident module.

| Type | For | Credentials |
| --- | --- | --- |
| Mailbox (IMAP) | Any IMAP server | User name and password; TLS (993) or STARTTLS (143). "None" is for a lab only. |
| Mailbox (Microsoft 365) | Exchange Online, through Microsoft Graph | An app registration (client ID and secret) with the application permission `Mail.ReadWrite`. Limit it to the mailbox with an application access policy. |

Each run reads up to 100 unread messages from the folder. Each handled message is then marked read and, if a folder
is set under **Move handled mail to**, moved there. A message whose handling failed stays unread for the next run.
Each Message-ID is handled once per mailbox, so a rerun or a message delivered twice never creates a second
incident.

**Use a dedicated mailbox.** Kernel reads only unread mail, so a message a person has already opened (in Outlook, on a
phone, through a shared mailbox) is skipped and never becomes an incident. If people must read the same mail, forward
or copy it to a mailbox only Kernel reads, or set **Move handled mail to** so that what remains in the folder is what
Kernel has not seen yet.

## What happens to a message

1. **Noise is ignored**: `Auto-Submitted` other than `no` (out-of-office, auto-replies), `Precedence: bulk`, `junk` or
   `list`, `X-Auto-Response-Suppress`, bounces (`mailer-daemon`, `postmaster`), and Kernel's own mail (its sender
   address or its Message-ID domain). Mail over the size limit (default 15 MB) is ignored too. More than 20 messages
   an hour from one sender to one mailbox are ignored (configurable). Kernel never replies to mail automatically,
   so it cannot start a mail loop.
2. **A reply** names an incident by a Message-ID Kernel sent (`In-Reply-To` or `References`), or by its ref in the
   subject, such as `[INC000123]`. It becomes a comment only if:
   - the sender is verified (see below);
   - the sender takes part in the incident: its caller or an affected person, its assignee, or a member of its team;
   - the incident is not closed.

   Otherwise it goes to **Incidents → Inbound email to review**, with the reason. It is never added silently.
3. **New mail** becomes an incident with the mailbox's team, impact and urgency. If the sender is verified, they
   become the caller: matched to a person by email address, or added as a new contact. If not, the incident is still
   created, but the sender is only named as reporter, marked "(unverified sender)", and never matched to a person.

The text is the new part of the message. HTML is turned into plain text, without scripts, styles or images. The quoted
message below "On … wrote:", "Den … skrev:" or an Outlook header block is cut. Attachments go through the
attachment service with its size limits and checks, at most 10 per message. What it refuses is noted on the
incident. Mail held for review keeps no attachments.

Agents get the text as `untrusted_content`, like all incident text: it was written by someone outside Kernel.

## Verified senders

The `From` address alone proves nothing. A sender is verified only when the receiving mail server vouched for it.
This means the **topmost** `Authentication-Results` header with the mailbox's **trusted mail server** (its
authserv-id, for example `mx.example.com`) shows one of:

- `dmarc=pass` for the From domain;
- `spf=pass` with an aligned `smtp.mailfrom` domain;
- `dkim=pass` with an aligned `header.d` domain.

Headers from other servers, and lower headers the sender added themselves, are ignored. Without a trusted mail server
set, no sender counts as verified. New mail still becomes incidents, but every reply waits for review.

**Alignment is on the domain suffix** (relaxed alignment): the SPF or DKIM domain is aligned when it is the From
domain, or when one of them is a subdomain of the other. `bounce.example.com` is aligned with `anna@example.com`, and
`example.com` with `anna@support.example.com`. `notexample.com` is not. Kernel does not consult the public suffix list,
so it relies on no one being able to pass SPF or DKIM for a bare public suffix such as `co.uk`.

### What your mail server must do

Kernel trusts the topmost header with your authserv-id because it assumes your receiving server **added that header
itself and removed any copies with the same authserv-id that arrived with the message** (RFC 8601 §5). Most servers do
this: Exchange Online, Gmail, Postfix with OpenDMARC or rspamd, and Microsoft 365 for its own authserv-id. If your
server does not, anyone can put a forged `Authentication-Results: mx.example.com; dmarc=pass` at the top of their mail,
and Kernel will believe it. `test/inbound-mail.test.ts` ("a forged header on top is believed…") shows this.

**Test it before you set a trusted mail server:**

1. From an outside account (not your domain), send a message to the mailbox with this header added on top. Use
   `swaks --add-header`, or a mail client that allows custom headers. Put your own authserv-id and domain in it:

   ```
   Authentication-Results: mx.example.com; dmarc=pass header.from=example.com
   ```

   Send it with a From address in your domain.
2. Open the delivered message's source in the mailbox. The test passes when the **topmost** `Authentication-Results`
   with your authserv-id is the server's own, showing `dmarc=fail` or `none` for that message, and your forged line is
   gone or only appears below it.
3. If your forged line is still the topmost one with that authserv-id, the server does not strip forged headers. Do
   not set a trusted mail server until that is fixed (for example, with rspamd's or OpenDMARC's header removal, or a
   transport rule that removes `Authentication-Results` from inbound mail before the server adds its own).

## Inbound email to review

Held mail is listed on the incidents page for everyone who works incidents. For each message, a person can:

- **Add** it to the incident it answered, as a comment marked with the sender;
- log it as a **New incident**;
- **Discard** it.

Each is audited. Once decided, the mail's text is no longer kept on the list. REST: `GET /api/inbound-mail` and
`POST /api/inbound-mail/:id/decide`. MCP: `list_inbound_mail` and `decide_inbound_mail`. Over MCP, discarding needs
the person's confirmation.

## Replies to Kernel's mail

Every email Kernel sends has its own Message-ID, recorded with the delivery. A person's mail client puts it in
`In-Reply-To` when they answer, which is how a reply finds its incident even when the subject was changed.
