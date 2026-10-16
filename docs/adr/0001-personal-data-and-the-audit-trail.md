# 1. Personal data and the append-only audit trail

Date: 2026-10-09 · Status: accepted · Issues: #57, #53, #39

## Context

The audit trail (`audit_log`) is append-only and hash-chained (HMAC keyed from `KERNEL_SECRET_KEY`), so nobody can
rewrite history unnoticed. GDPR gives people the right to have their personal data erased or anonymised (Art. 17)
and requires storage limitation (Art. 5(1)(e)). An immutable table that stores names, email addresses, IP addresses
and free text (which may mention people) cannot meet both. #39 will add callers and affected users, so this has to be
settled first.

Options considered:

1. **Crypto-shredding**: encrypt personal values per data subject and delete the key on erasure. Rejected: free text
   often mentions several people, so each text would need to know whose data it contains; keys live on in backups;
   complex and fragile.
2. **Keep personal data out of the audit trail** (chosen): the trail proves *that* something changed, by whom (an id)
   and how (codes, refs, digests); the content lives in the mutable record histories, where retention and
   anonymisation are plain updates.

## Decision

From migration 114 on, new audit entries:

- store the actor's **user id** only (`actor_name` and `ip` are empty); the name is joined from `users` when shown, and an
  erased user shows as "deleted user #42";
- use `#<id>` instead of a username as the reference of user and session entries;
- keep short code-like values readable (statuses, priorities, refs, ids, dates, numbers) and replace **personal
  fields and free text** with `{ "digest": "hmac-sha256:…", "length": n }` (`minimise()` in `audit.ts`). The digest is
  keyed from `KERNEL_SECRET_KEY` (label `kernel-audit-digest:`): a plain hash of a short value such as an email or a
  personal identity number could be reversed by trying candidates, which would make the digest personal data itself. The full texts are
  in `problem_activity`, `incident_activity`, `change_activity` and `ci_activity`, and on the records themselves;
- store **IP address and user agent** in `audit_context`, outside the chain, deleted after
  `settings.privacy.audit_context_days` (365 by default; security under legitimate interest).
- keep **security events** (`security_events`, #64) under the same legitimate interest: the user id, IP address,
  user agent and country of sign-ins, denials and admin changes, deleted after `settings.privacy.security_event_days`
  (365 by default). A sign-in name that matches no account is stored only as a digest. Both retention periods are set
  in **Administration → Security events** (30 to 3650 days, with step-up and a reason, audited).

Kept as is: the **reason** for sensitive actions (written by staff to justify an action) and the actor id. Reasons
must not carry personal details: the dialog says so, and the server refuses reasons containing an email address or a
Swedish personal identity number (the #61 scanner will widen this).

**Erasure** of a user (`POST /api/users/:id/erase`, administrators, with a reason) anonymises the account (username,
name, email, credentials, settings) and ends sessions and tokens. The chain stays valid because it never contained
the name. What erasure does not remove is the network context in `audit_context` and `security_events` (IP address and
user agent): it stays under legitimate interest until its retention period ends, and the erase dialog says so. The
account's name is removed from Kernel's own security alerts. Erasure of personal data in records (#53) redacts the record fields and histories; the audit digests then
no longer match any stored text, which is the intended outcome.

## Existing entries

Entries written before migration 114 still contain names, IPs and texts. Rewriting them means re-basing the chain
(recomputing every hash) – a one-time, irreversible operation that must be run by the database owner, recorded as an
`audit.chain_rebased` entry naming the old head hash (which the external Elasticsearch anchors also hold). It is
**not** done automatically; the administrator decides whether and when to run it. Until then the security status
shows how many such entries remain, and the erase dialog says that they may still name the user.

**Decision (2026-10-14):** the administrator decided to re-base. The tool is `server/src/rebase-audit.ts`, and the procedure is in [docs/audit-rebase.md](../audit-rebase.md). The re-base rewrites every legacy entry with the rules new entries follow:

- no actor name;
- the user's id in place of a username;
- digests in place of personal values and free text;
- the sensitive-data scanner run on short values and reasons.

IP addresses and user agents move into `audit_context`, where they are subject to its retention. The tool then recomputes the whole chain with the active key. It writes an `audit.chain_rebase_intent` entry (the old head) before the rewrite and an `audit.chain_rebased` entry (old head, new head, rows rewritten, key id) after it. Both entries also go to the SIEM anchor stream. Anchors up to the old head are compared with the old head's hash, which the `audit.chain_rebased` entry records, and anchors after it with the database.

Executed on 2026-10-14 in production, after a verified backup and a dress rehearsal on a restored copy whose dry run gave the same counts. Two of the three legacy entries were rewritten (actor name, IP address, user agent and user reference). The chain was recomputed with key `k0` and verifies, and a second dry run finds nothing left to change. The old head was entry 3 (`7f1283b9…`), and the intent entry 4 became the boundary: its hash before the rewrite was `ae1cb0cc…` and after it `0881565f…`. The pre-re-base dump is kept outside the backup rotation.

## Consequences

- The audit page shows "text changed (digest, length)" for free text; the record's history shows the text itself.
- Investigations needing the IP of an action older than the retention period cannot get it.
- New fields that may hold personal data must be added to the `PERSONAL` pattern in `audit.ts` (see
  `docs/ux-guidelines.md`, checklist item 5).
