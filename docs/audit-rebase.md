# Runbook: re-basing the legacy audit entries

This is a one-time, irreversible rewrite of audit entries written before ADR 0001. Those entries may hold names, IP addresses, user agents, free text, and short secrets kept verbatim. The rewrite applies the rules that new entries follow and recomputes the hash chain with the active key. See [ADR 0001](adr/0001-personal-data-and-the-audit-trail.md).

The tool is `server/src/rebase-audit.ts`. It runs as the database owner, never through the API.

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
docker compose run --rm -e DATABASE_URL="$copy" app node server/dist/rebase-audit.js
docker compose run --rm -e DATABASE_URL="$copy" app node server/dist/rebase-audit.js --execute
```

- **Dry run:** prints how many entries change per field, with entry ids and no values.
- **Real run:** must end with "chain verifies".

Then drop the copy:

```sh
docker compose exec -T db psql -U kernel -d postgres -c 'DROP DATABASE kernel_rebase_check'
```

## 3. The real run

```sh
docker compose exec app node server/dist/rebase-audit.js            # dry run: the same counts as on the copy
docker compose exec app node server/dist/rebase-audit.js --execute
```

The rewrite runs in one transaction under the same lock as every append, so no entry is written meanwhile. It runs in this order:

1. An `audit.chain_rebase_intent` entry records the current head.
2. Every entry is rewritten and the chain is recomputed.
3. An `audit.chain_rebased` entry records the old head, the new head, the number of rows rewritten and the key id.
4. The chain is verified.

If verification fails, the tool says so and exits non-zero. Then restore the backup from step 1 with `scripts/restore.sh`.

## 4. Afterwards

- **Security status:** **Administration → Security status → Audit trail personal data** shows no legacy entries, and the chain verification is OK.
- **SIEM:** search Elasticsearch for `audit.chain_rebased`. The anchors older than it point at the old hashes. That is expected, and the entry names both heads.
- **ADR 0001:** fill in the execution date.
- **The backup:** delete the manual dump once the next scheduled backup has been taken and verified.
