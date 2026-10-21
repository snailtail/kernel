# Service requests

Not everything people ask IT for is an incident. "A new account", "access to a system" or "a new VM" are requests:
nothing is broken, someone needs something. Kernel keeps them apart from incidents (ITIL 4 *service request
management*), so they never count in incident numbers, and gives them a short, predictable path: a form, an approval
when it is needed, and the tasks that fulfil it, in order.

Service requests are an **optional module**, off until an administrator turns it on (Administration → Modules, or the
setup wizard). When it is off, its pages, API routes and MCP tools are gone; nothing is deleted.

## The catalogue

Managers keep the catalogue under **Administration → Request catalogue**. Each item belongs to a service and has:

- **a form** of at most 10 fields: short text, long text, choice, person (from People), CI, date. Kernel checks the
  answers on the server: unknown fields, wrong types, and people or CIs that do not exist are refused;
- **an approval**: none, the requester's manager (People → manager, who needs a Kernel account), the service owner,
  or the members of a team;
- **the fulfilment tasks**, in order, each for a team (or anyone). A task is done in one of three ways:
  - *a person does it* and marks it done;
  - *standard change*: Kernel makes a standard change from the item's template when the task opens, on the CIs the form
    names (or the service). Recording the change's outcome completes the task: successful moves on to the next task;
    failed or rolled back leaves it open for the team (who can then raise a new change or finish it by hand);
  - *webhook*: Kernel calls an outgoing webhook, which calls back when it is done (below);
- **an SLA** (else the service's, else the default one).

### An example catalogue

| Item | Form | Approval | Tasks |
| --- | --- | --- | --- |
| New account | Full name, start date, role (choice) | none | 1. Create the account (Identity team, or a webhook to the directory) · 2. Send the welcome email |
| Access to a system | System (CI), access level (Read / Write), why (long text), until (date) | the requester's manager | 1. Grant the access (the system's team) · 2. Tell the requester |
| New VM | Size (choice), what is it for (long text) | the service owner | 1. Provision the VM (standard change "Provision a VM") · 2. Add monitoring |

Start with the three or four requests you get most. A form with more than a handful of fields is usually a sign that
the item should be split, or that the answer belongs in a conversation.

## A request

**+ New → Request** opens the catalogue; pick an item, say who it is for (yourself by default), and answer the form.
The request (`REQ000012`) is made *for* a person in People and *logged by* you.

1. **Approval.** The approvers are worked out when the request is submitted and stored with it. The requester never
   approves their own request. By default, the person who logs it does not either (separation of duties); an item can
   allow it, and then the history and the audit trail say "logged and decided by the same person". At the decision
   Kernel checks again that the approver still is one (still the manager, the service owner, in the team). Approvers
   decide in the web UI or from the Approve / Reject links in their email or chat message. An AI agent or an API token
   never approves. Rejecting needs a reason.
2. **Fulfilment.** The tasks are created when the request is approved (at once without approval). Only the first is
   open; the next opens when the one before is done. Open tasks wait in their team's queue (Teams page), in My work and
   in the menu badge. The last task done fulfils the request.
3. **The SLA clock** runs from submission to fulfilment and pauses while the request waits for approval. Warnings and
   breaches go to the person on the open task, or its team lead.

Requests follow the same rules as other records: they can be restricted and confidential (then free-text answers are
masked for everyone except the person who logged it and the teams and people on its tasks), and secrets in what is typed are
redacted on the way in.

## The requester hears about it

The requester is told when the request is received, approved or not approved, done, or cancelled, in plain words:
only the request's own title and where it stands, never notes, answers or who works on it (`audience.ts`,
`forRequester`). A restricted request is named by its ref only.

- A requester **with a Kernel account** gets it as a notification (their own settings decide email or chat), unless
  they logged the request themselves.
- Everyone else gets **email**, with a one-click unsubscribe link (RFC 8058). Unsubscribing stops request email for that
  person; it is in the audit trail.

## Webhook tasks

An administrator creates an outgoing webhook (Administration → Webhooks, JSON format; choose the event
`request.task` only, so it receives nothing else). A manager then picks it for a task. When the task opens, Kernel
sends, signed like every webhook (Standard Webhooks headers and `X-Kernel-Signature`):

```json
{
  "event": "request.task",
  "request": { "ref": "REQ000012", "title": "New account for Karin Holm", "item": "New account",
               "service": { "ref": "SVC000001", "name": "Identity" }, "url": "https://kernel.example.com/requests/REQ000012" },
  "task": { "id": 41, "title": "Create the account", "position": 1 },
  "answers": { "full_name": "Karin Holm", "start": "2026-11-02", "role": "Customer service" },
  "callback": { "url": "https://kernel.example.com/api/requests/REQ000012/tasks/41/complete", "method": "POST",
                "header": "X-Kernel-Task-Token", "token": "…", "expires_at": "2026-11-09T10:00:00.000Z" }
}
```

What goes out: the request's ref, title, item and the form's answers. Never comments or task notes. A confidential
request leaves out its free-text answers, and a restricted one is sent as its ref only.

When the work is done, the receiver calls back:

```
POST /api/requests/REQ000012/tasks/41/complete
X-Kernel-Task-Token: <the token>
Content-Type: application/json

{ "status": "done", "note": "Account kpholm created" }
```

`"status": "failed"` leaves the task open and tells the team, so a person takes over. The token is bound to that
one task: 256 random bits, of which Kernel stores only the SHA-256. It works once and expires after 7 days. A
retried delivery mints a new one, and the old one stops working. No script ever runs on the Kernel host.

## API and MCP

REST: `/api/request-items` (the catalogue; `/options` lists templates and JSON webhooks for the editor),
`/api/requests` (+ `/:ref/approval`, `/transition` to cancel, `/tasks/:id/complete`, `PATCH /tasks/:id` to take a task,
`/links`, `/comments`). See the OpenAPI document under *Service requests*.

MCP: `list_request_items`, `list_requests`, `get_request`, `create_request`, `update_request`, `transition_request`
(cancel only) and `complete_request_task`. Free text comes back under `untrusted_content`. Agents log and follow
requests. They do not approve them.
