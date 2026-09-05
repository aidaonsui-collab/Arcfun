#!/bin/zsh
# Rotate Jessica's indexer.log — it has no rotation of its own (plain `>> indexer.log 2>&1`
# shell redirection in scripts/run-indexer-jessica.sh), so left alone it just grows forever
# (848MB and counting as of 2026-09-05).
#
# Copy-then-truncate, not rename-then-recreate: the daemon holds indexer.log open via O_APPEND
# shell redirection with no signal handler to make it reopen a fresh file, so a rename would
# either strand its writes in the renamed (about-to-be-compressed) file forever, or leave a new
# empty indexer.log that never receives anything. Truncating the file IN PLACE is safe for an
# O_APPEND writer — the next write just recalculates its offset from the (now zero) file size —
# which is exactly the same trick logrotate's `copytruncate` option uses for processes that can't
# be told to reopen their log.
#
# Installed as a launchd job (see com.arcfun.log-rotate.plist) rather than cron — more idiomatic
# on macOS and doesn't need Full Disk Access the way user cron does on newer macOS versions.
set -euo pipefail

LOG="/Users/hectorhernandez/code/arcfun/indexer.log"
MAX_BYTES=$((200 * 1024 * 1024))  # rotate once past 200MB
KEEP_DAYS=14                       # delete rotated copies older than this

[[ -f "$LOG" ]] || exit 0

size=$(stat -f%z "$LOG")
if (( size <= MAX_BYTES )); then
  exit 0
fi

stamp=$(date +%Y%m%d-%H%M%S)
archive="${LOG}.${stamp}"

cp "$LOG" "$archive"
: > "$LOG"
gzip -f "$archive"

find "$(dirname "$LOG")" -maxdepth 1 -name "$(basename "$LOG").*.gz" -mtime "+${KEEP_DAYS}" -delete
