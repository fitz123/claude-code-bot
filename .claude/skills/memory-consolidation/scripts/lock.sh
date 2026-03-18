#!/bin/bash
# Atomic lock management using mkdir.
# Usage: lock.sh {acquire|release|check-maintenance} LOCK_PATH [STALE_TTL_MINUTES]
#
# Actions:
#   acquire          — create lock directory atomically; reclaim if stale
#   release          — remove lock directory
#   check-maintenance — check if .maintenance.lock exists in LOCK_PATH (workspace dir)
#
# Exit codes:
#   0 — success (ACQUIRED / RELEASED / CLEAR)
#   1 — blocked (LOCKED / MAINTENANCE)
#   2 — usage error
set -euo pipefail

usage() {
  echo "Usage: lock.sh {acquire|release|check-maintenance} LOCK_PATH [STALE_TTL_MINUTES]" >&2
  exit 2
}

ACTION="${1:-}"
LOCK_PATH="${2:-}"
STALE_TTL="${3:-60}"

[ -z "$ACTION" ] && usage
[ -z "$LOCK_PATH" ] && usage

# Portable stat: get file modification time as epoch seconds
file_mtime() {
  # macOS
  stat -f %m "$1" 2>/dev/null && return
  # Linux
  stat -c %Y "$1" 2>/dev/null && return
  echo 0
}

case "$ACTION" in
  acquire)
    # Check for stale lock first
    if [ -d "$LOCK_PATH" ]; then
      lock_pid_file="$LOCK_PATH/pid"
      if [ -f "$lock_pid_file" ]; then
        lock_pid=$(cat "$lock_pid_file" 2>/dev/null || echo "")
        # If the lock-holding process is still alive, the lock is valid regardless of age
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
          echo "LOCKED"
          exit 1
        fi
        lock_time=$(file_mtime "$lock_pid_file")
        now=$(date +%s)
        age_minutes=$(( (now - lock_time) / 60 ))
        if [ "$age_minutes" -ge "$STALE_TTL" ]; then
          echo "Reclaiming stale lock (pid $lock_pid dead, age: ${age_minutes}m, ttl: ${STALE_TTL}m)" >&2
          rm -rf "$LOCK_PATH"
        else
          echo "LOCKED"
          exit 1
        fi
      else
        # Lock dir exists but no pid file — treat as stale
        echo "Reclaiming orphaned lock (no pid file)" >&2
        rm -rf "$LOCK_PATH"
      fi
    fi

    # Atomic lock acquisition via mkdir
    if mkdir "$LOCK_PATH" 2>/dev/null; then
      echo $$ > "$LOCK_PATH/pid"
      date -u +%Y-%m-%dT%H:%M:%SZ > "$LOCK_PATH/timestamp"
      echo "ACQUIRED"
      exit 0
    else
      echo "LOCKED"
      exit 1
    fi
    ;;

  release)
    if [ -d "$LOCK_PATH" ]; then
      rm -rf "$LOCK_PATH"
      echo "RELEASED"
    else
      echo "NO_LOCK"
    fi
    ;;

  check-maintenance)
    # LOCK_PATH here is the workspace directory
    if [ -d "$LOCK_PATH/.maintenance.lock" ]; then
      echo "MAINTENANCE"
      exit 1
    else
      echo "CLEAR"
      exit 0
    fi
    ;;

  *)
    echo "Unknown action: $ACTION" >&2
    echo "Usage: lock.sh {acquire|release|check-maintenance} LOCK_PATH [STALE_TTL_MINUTES]" >&2
    exit 2
    ;;
esac
