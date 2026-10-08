#!/usr/bin/env bash
# Restores a Kernel backup into the running compose stack. Run on the Docker host, in the Kernel directory.
#
#   scripts/restore.sh backups/daily/kernel-2026-10-08_0230.dump           replace the kernel database
#   scripts/restore.sh --verify backups/daily/kernel-2026-10-08_0230.dump  restore into a scratch database
#                                                                          and compare row counts, no downtime
set -euo pipefail

verify=false
if [ "${1:-}" = --verify ]; then verify=true; shift; fi
file="${1:?usage: scripts/restore.sh [--verify] <dump file>}"
[ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }

psql() { docker compose exec -T db psql -U kernel -v ON_ERROR_STOP=1 "$@"; }
counts() { psql -d "$1" -tAc "SELECT 'problems=' || (SELECT count(*) FROM problems) || ' activity=' || (SELECT count(*) FROM problem_activity) || ' users=' || (SELECT count(*) FROM users)"; }

if $verify; then
  psql -d postgres -qc 'DROP DATABASE IF EXISTS kernel_restore_check' -qc 'CREATE DATABASE kernel_restore_check'
  docker compose exec -T db pg_restore -U kernel -d kernel_restore_check --no-owner < "$file"
  echo "backup:  $(counts kernel_restore_check)"
  echo "live:    $(counts kernel)"
  psql -d postgres -qc 'DROP DATABASE kernel_restore_check'
  echo "Restore check OK"
  exit
fi

read -r -p "This replaces ALL data in the kernel database with $file. Type 'restore' to continue: " answer
[ "$answer" = restore ] || { echo "Aborted"; exit 1; }
docker compose stop app
psql -d postgres -qc 'DROP DATABASE kernel WITH (FORCE)' -qc 'CREATE DATABASE kernel'
docker compose exec -T db pg_restore -U kernel -d kernel --no-owner < "$file"
docker compose start app
echo "Restored: $(counts kernel)"
