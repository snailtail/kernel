#!/bin/sh
# Nightly PostgreSQL backups for Kernel. Runs inside the "backup" compose service.
#
# Keeps KEEP_DAILY daily, KEEP_WEEKLY weekly (Sundays) and KEEP_MONTHLY monthly (1st) dumps in
# /backups/{daily,weekly,monthly}. Dumps use pg_dump's custom format; restore with scripts/restore.sh.
set -eu

: "${BACKUP_TIME:=02:30}"
: "${KEEP_DAILY:=7}"
: "${KEEP_WEEKLY:=4}"
: "${KEEP_MONTHLY:=6}"
dir=/backups

prune() { # keep the newest $2 files in $1
  ls -1t "$1"/kernel-*.dump 2>/dev/null | tail -n +"$(($2 + 1))" | while read -r f; do rm -f "$f"; done
}

backup() {
  mkdir -p "$dir/daily" "$dir/weekly" "$dir/monthly"
  name="kernel-$(date +%Y-%m-%d_%H%M).dump"
  tmp="$dir/.partial-$name"
  if pg_dump -Fc -f "$tmp"; then
    mv "$tmp" "$dir/daily/$name"
    [ "$(date +%u)" = 7 ] && cp "$dir/daily/$name" "$dir/weekly/$name"
    [ "$(date +%d)" = 01 ] && cp "$dir/daily/$name" "$dir/monthly/$name"
    prune "$dir/daily" "$KEEP_DAILY"
    prune "$dir/weekly" "$KEEP_WEEKLY"
    prune "$dir/monthly" "$KEEP_MONTHLY"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/last-success"
    echo "$(date -u +%FT%TZ) backup ok: $name ($(du -h "$dir/daily/$name" | cut -f1))"
  else
    rm -f "$tmp"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/last-failure"
    echo "$(date -u +%FT%TZ) backup FAILED" >&2
  fi
}

if [ "${1:-}" = now ]; then
  backup
  exit
fi

echo "Kernel backups daily at $BACKUP_TIME (keep $KEEP_DAILY daily, $KEEP_WEEKLY weekly, $KEEP_MONTHLY monthly)"
# Take a first backup at start if there is none yet.
[ -f "$dir/last-success" ] || backup
while :; do
  now=$(date +%s)
  next=$(date -d "$(date +%Y-%m-%d) $BACKUP_TIME" +%s 2>/dev/null || date -D '%Y-%m-%d %H:%M' -d "$(date +%Y-%m-%d) $BACKUP_TIME" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  backup
done
