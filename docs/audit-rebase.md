# Runbook: re-basing the legacy audit entries

This is a one-time, irreversible rewrite of audit entries written before ADR 0001. Those entries may hold names, IP addresses, user agents, free text, and short secrets kept verbatim. The rewrite applies the rules that new entries follow and recomputes the hash chain with the active key. See [ADR 0001](adr/0001-personal-data-and-the-audit-trail.md).

The tool is `server/src/security/rebase-audit.ts`. It runs as the database owner, never through the API.

## 1. Back up and verify, outside the rotation

Take the backup into its own directory. The backup service rotates only `daily`, `weekly` and `monthly`, so this dump stays until you delete it.

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T backup sh -c "mkdir -p /backups/manual && pg_dump -Fc -f /backups/manual/kernel-pre-audit-rebase-$stamp.dump"
scripts/restore.sh --verify backups/manual/kernel-pre-audit-rebase-$stamp.dump
```

Keep the dump until the re-base has been verified, at least past the next verification run in step 4.

## 2. Dress rehearsal on a copy

Restore the dump into a scratch database, and run the dry run and then the real run there first:

```sh
docker compose exec -T db psql -U kernel -d postgres -c 'DROP DATABASE IF EXISTS kernel_rebase_check' -c 'CREATE DATABASE kernel_rebase_check'
docker compose exec -T db pg_restore -U kernel -d kernel_rebase_check --no-owner < backups/manual/kernel-pre-audit-rebase-$stamp.dump
copy="postgres://kernel:$POSTGRES_PASSWORD@db:5432/kernel_rebase_check"
docker compose run --rm -e DATABASE_URL="$copy" app node server/dist/security/rebase-audit.js
docker compose run --rm -e DATABASE_URL="$copy" app node server/dist/security/rebase-audit.js --execute
```

- **Dry run:** prints how many entries change per field, with entry ids and no values.
- **Real run:** must end with "chain verifies".

Then drop the copy:

```sh
docker compose exec -T db psql -U kernel -d postgres -c 'DROP DATABASE kernel_rebase_check'
```

## 3. The real run

```sh
docker compose exec app node server/dist/security/rebase-audit.js            # dry run: the same counts as on the copy
docker compose exec app node server/dist/security/rebase-audit.js --execute
```

The rewrite runs in one transaction under the same lock as every append, so no entry is written meanwhile. It runs in this order:

1. An `audit.chain_rebase_intent` entry records the current head. It then becomes the last entry of the old chain: the `old_head` that the result names.
2. Every entry is rewritten and the chain is recomputed.
3. An `audit.chain_rebased` entry records the old head, the new head, the number of rows rewritten and the key id.
4. The chain is verified.

The rewritten chain is verified inside the transaction, before it commits. If it does not verify, everything is rolled back and the trail is as it was. After the commit, the app's own check runs once more.

Restoring the backup from step 1 with `scripts/restore.sh` is the last resort, for a failure after the commit.

## 4. Afterwards

- **Security status:** **Administration → Security status → Audit trail personal data** shows no legacy entries, and the chain verification is OK.
- **SIEM:** search Elasticsearch for `audit.chain_rebased`.

### Comparing anchors after a re-base

Elasticsearch keeps an anchor (id and hash) for every entry. It never changes, which is what makes it useful against tampering. After a re-base, the anchors split at the boundary named in `audit.chain_rebased`:

- **Anchors up to and including `old_head.id`** were made over the old chain. Do not compare them with the database. `old_head` is the `chain_rebase_intent` entry itself: it is written just before the rewrite, and the rewrite reads the head under the append lock. Check that its anchor equals `old_head.hash` in the `audit.chain_rebased` entry, and that it names the head before it. Together these link the old chain, as Elasticsearch saw it, to the re-base.
- **Anchors after `old_head.id`** compare with the database as usual. The first of them is the `chain_rebased` entry.

A mismatch in the second group is a real finding. In the first group a mismatch is expected for every entry except `old_head`.
- **ADR 0001:** fill in the execution date.
- **The backup:** delete the manual dump once the next scheduled backup has been taken and verified.
