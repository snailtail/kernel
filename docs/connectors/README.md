# Connectors and the CI lifecycle

Kernel's CMDB is fed by sources: pull connectors that Kernel runs on a schedule (OP5 Monitor,
[Kubernetes](kubernetes.md)), and anything that pushes with `POST /api/cmdb/ci-batch` or the MCP tool `sync_ci_batch`.
Both go through the same sync, so they share reconciliation, missing detection and the lifecycle below. A connector
only fetches and maps; scheduling, credentials, reconciliation and the run log belong to the framework
(`server/src/connectors.ts`).

Support mailboxes (IMAP, Microsoft 365) are connectors too: they create incidents instead of CIs, and use the same
credentials, schedule, lease and run log. See [inbound email](../inbound-email.md).

## The scheduler

Every minute, the server runs **every** connector that is due, at most three at a time, so one slow source never holds
up the others. Each run takes a lease on its connector row first, which means:

- a connector never runs twice at once, not even with several replicas (a replica skips what another one took);
- **Run now** while a scheduled run is going answers "already running";
- a tick waits for the previous one, so the limit of three holds even when runs take longer than a minute.

A run whose fetch has no complete answer within **10 minutes** is stopped and logged as failed ("no complete answer
within 10 minutes") and the other connectors carry on. A failed run never marks anything missing. A connector
type's `fetch` must honour `ctx.signal` (pass it to every request and check it in long loops): the lease is released
only once the stopped fetch has actually settled, or after 30 minutes, so a fetch that ignores the signal keeps its
connector from running again until then. The run log under **Administration → Connectors** shows counts, errors and the duration of each run.

## Lifecycle: active → missing → proposed → retired

```
active ──(no source reports it for 3 full syncs)──▶ missing ──(retire_after_days)──▶ proposed for retirement
   ▲                                                   │                                 │
   └──────────────(a source reports it again)──────────┴─────────────────────────────────┤
                                                                       a person retires it ▼
                                                                                      retired
```

1. **Missing.** A full snapshot (`full_sync: true`) that no longer contains a CI counts a missed sync for that source.
   When every source that reports the CI has missed it three times (`missing_after` in the `cmdb_reconciliation`
   setting), the CI becomes `missing`. A snapshot that shrank by more than half is refused and marks nothing; parts a
   connector could not read (`incomplete_prefixes`) are left alone.
2. **Proposed for retirement.** A CI that has been missing for `retire_after_days` appears on **CMDB → Proposed for
   retirement** (`/cis/retire`), with a health tip on the dashboard. Each connector sets its own number of days in the
   connector form (default 14). A CI reported by several sources waits for the most patient one; push sources and
   CIs without sources use `retire_after_days` in the `cmdb_reconciliation` setting (default 14).
3. **Retired.** A person decides. The list shows each CI's sources and when they last saw it, its relationships and
   the open incidents, problems and changes that still name it. An administrator or CMDB manager can retire any CI,
   and an owner their own, one at a time or several at once. A CI that open records name is only retired after an
   explicit "retire anyway". Every retirement is a status change in the CI's history and the audit trail, with the
   reason given.

Kernel never retires a CI by itself and never deletes one. A CI that a source reports again before it is retired goes
back to `active` and leaves the list. A retired CI keeps its history, and it can be set active again by hand.

| | REST | MCP |
|---|---|---|
| List the proposals | `GET /api/cis/retire-proposals` | `list_retire_proposals` |
| Retire | `POST /api/cis/retire` `{ refs, comment?, acknowledge_open? }` | `retire_cis`, which needs `human_confirmation` quoting the person |

The result lists every CI with its outcome (`retired`, `unchanged`, `skipped` with the reason, or `failed`).
