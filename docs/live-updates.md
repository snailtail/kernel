# Live updates

Record pages, lists and My work update without reloading when someone changes a problem, incident, change or CI. A record page also shows who else has it open, and who is typing in it.

## How it works

1. **Notification.** Database triggers send a notification on the `kernel_live` channel when a record changes, or anything attached to it changes: comments, actions, links, CIs, votes and so on. The notification contains only the kind and id, for example `problem:12`. It is sent when the transaction commits; a change that is rolled back sends nothing.
2. **Fan-out.** Each Kernel instance listens on one dedicated database connection outside the pool. With several replicas, every instance receives every notification.
3. **Visibility check.** Before Kernel sends anything to a browser, the database answers, with that person's own visibility rules (row-level security), whether they may see the record. People who cannot see a restricted record never learn that it changed, not even that it exists.
4. **Refetch.** The browser receives only `{kind, id}` and refetches through the normal API, where the usual authorisation applies.

## Security and limits

- **Who can connect.** Only signed-in browsers can open a stream (`GET /api/live`, session cookie). Bearer tokens are refused: agents and integrations use webhooks.
- **Re-checks.** Every stream re-checks its session, account, role and teams at least once a minute, and before sending an event if the last check is older than 15 seconds.
  - A revoked or expired session, or a disabled account, closes the stream.
  - A change of team or role re-filters what the stream follows.
  - The stream does not extend the session's idle timeout.
- **Streams per user.** At most 6 per user (`KERNEL_LIVE_PER_USER`). When a user opens one more, their oldest stream closes, so a reloaded tab never locks itself out.
- **Streams in total.** At most 1000 (`KERNEL_LIVE_TOTAL`). Beyond that, pages fall back to refreshing every 30 seconds.
- **Heartbeat.** A comment is sent every 25 seconds, so Cloudflare and other proxies keep the connection open.
- **Slow clients.** A client that falls more than 256 kB behind is disconnected. It reconnects and refetches.
- **No replay.** After a reconnect the page refetches what it shows; old events are not replayed.
- **Disabled modules.** Nothing is sent for record kinds whose module is switched off.

## Presence

- **Visibility.** Presence shows the names of other people who have the same record open. It only reaches people who can see that record.
- **Storage.** It lives in memory only; nothing is stored.
- **Opting out.** Anyone can turn it off under **Settings → Show that I have a record open**. They then no longer appear to others.
- **Editing.** "Is editing" means the cursor is in a field on the record page. It is a hint, not a lock. Conflicting saves are still caught by the version check and resolved on the page.
