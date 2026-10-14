# Sensitive data in records

Logs pasted into incidents and problems often contain passwords, keys and tokens, and sometimes personal data. Kernel has one scanner (`server/src/sensitive.ts`) for everything it takes in, and uses it for what it sends to a language model too.

## What is detected

| Kind | Examples | Handling |
| --- | --- | --- |
| Secrets | PEM private keys, AWS access and secret keys, Azure account keys and SAS signatures, Google API keys, GitHub and Slack tokens, Slack webhook URLs, Kernel API tokens, JWTs, bearer tokens, passwords in URLs, `password=`/`secret=`/`api_key=` and connection strings, card numbers (with Luhn check) | Redacted before storage |
| Personal data | Swedish personal identity and coordination numbers (with date and checksum), email addresses, optionally IP addresses | Kept; the record is marked |

Only the secret part of a match is replaced. `password=hunter2` becomes `password=[REDACTED:password]`, so the line still makes sense.

A value given with a colon must look like a password, with digits or symbols. That way prose such as "password: reset by the user" is left alone.

## Where it applies

- **Write requests.** Secrets are redacted in every string of every write request (REST and MCP) before a handler sees it. The scan covers:
  - descriptions, comments and work notes;
  - events and alerts from monitoring;
  - inbound records from integrations.

  Secrets therefore never reach the record, its history, notifications, webhooks or the audit trail.
- **Text attachments.** Secrets in logs and configuration files are redacted in the file itself before it is stored. Personal data in them is flagged.
- **Language models.** Text sent to a language model has secrets and personal identity numbers redacted.
- **Audit reasons.** Reasons in the audit trail may not contain personal data.

## Routes that are not scanned

Some routes take secrets on purpose:

- signing in, passwords and passkeys;
- API tokens;
- credentials Kernel stores encrypted: webhooks, connectors, AI providers, SSO, event and dev sources, chat URLs;
- creating users and setup.

They are listed in `UNSCANNED`, and a test fails when the list of excluded routes changes. A new route is therefore scanned unless someone decides otherwise.

## Policy

Administrators set the policy under **Administration → Security status → Sensitive data in records**. Changing it requires step-up and a reason, and the change is audited.

- **Secrets:** choose one of two modes.
  - *Replace with [REDACTED]* (default): the text is saved without the secret, and the writer is told what was removed.
  - *Refuse*: the request fails with `422` and lists what was found. Monitoring, integrations and MCP are never refused, so no alert is lost; their input is always redacted.
- **Personal data:** mark records whose text holds personal identity numbers or email addresses (`contains_personal_data`). This is on by default.
- **IP addresses:** count them as personal data. This is off by default, because they are everyday operational data.

## In the web UI

- **While writing.** While someone types or pastes into a field on a record page, Kernel warns: "This looks like a password. Kernel will replace it with [REDACTED] when you save."
- **The check.** The check runs on the server's scanner, so the warning and the saved result always agree. It is debounced and returns only the kinds it found; nothing is stored or logged.
- **After saving.** If something was redacted, a notice says what.
- **Marked records.** Records marked as holding personal data show a *Personal data* badge.

## Removing text that is already stored

Secrets written before the scanner existed, or personal details that should not have been written at all, can be removed from a record afterwards. Open the record, go to **Visibility → Remove sensitive text…**, and choose what to remove:

- everything the scanner recognises as a secret;
- an exact text, such as a name or an account number;
- or both.

Only problem managers and administrators can do this. It requires step-up and a reason.

The text is replaced with `[REDACTED]` everywhere on the record:

- its fields;
- comments and history entries, including the old and new values in them;
- actions and analyses;
- link notes and URLs;
- text attachments.

Kernel's own copies are cleaned too: in-app notifications and stored webhook payloads. Queued webhook payloads therefore go out clean.

Before anything is removed, the dialog shows a preview. The preview is a dry run of the very same statements, and changes nothing. It shows:

- how many occurrences will go, per place;
- what is already out of Kernel's reach, such as emails and chat messages sent, and webhooks delivered, with counts;
- knowledge articles copied from the record, which are separate records to clean as well;
- screenshots and other images, which are not scanned.

Copies in Elasticsearch hold no field values. Backups taken earlier are not changed; they age out with their retention.

History entries are not deleted, so the record still shows *that* something changed.

The removal is itself recorded on the record and in the audit trail, with the reason and how much was removed. The removed text is never written there; the audit trail keeps only a keyed digest of it. The audit trail held only digests of free text to begin with, so its hash chain stays valid.

## Confidential records

A record can be marked **confidential** under **Visibility → Mark confidential**. Marking it, or unmarking it, takes a reason. The change is audited and noted on the record.

A confidential record stays visible: it shows up in lists and searches, and its title, status and other fields can be read. Restricted records (#53) are different: they are hidden altogether.

**Who reads the text.** The free text is masked by the server: description, root cause, workaround, resolution and plans; comments and the values in history entries; link notes; and attachments. It is readable without masking only for:

- the assignee;
- the creator;
- members of the record's team.

**Reveal on demand.** Everyone else who works in Kernel can reveal the text for 15 minutes. That takes step-up and a reason. The reveal is noted on the record, where its people can see who looked, and in the audit trail. Problem managers reveal like anyone else, because overseeing a record is not the same as working on it.

**Writing.** A field you cannot read cannot be overwritten.

**Always masked.** AI agents (MCP) and exports always get the masked text, even for the record's own people, because both leave Kernel's access control. Live updates carry only kind and id, and each browser refetches through the normal API, so a reveal is never shared.

**AI models.** A confidential record's text goes only to an AI provider that is explicitly allowed confidential data, under **Administration → AI**.

