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

History entries are not deleted, so the record still shows *that* something changed.

The removal is itself recorded on the record and in the audit trail, with the reason and how much was removed. The removed text is never written there; the audit trail keeps only a keyed digest of it. The audit trail held only digests of free text to begin with, so its hash chain stays valid.

## Still to come

These parts of #61 are not built yet:

- confidential classification;
- masked fields that are revealed on demand.
