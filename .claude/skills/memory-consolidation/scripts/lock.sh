#!/bin/bash
# Atomic lock management using mkdir with ownership tokens.
# Usage: lock.sh {acquire|release|refresh|check-maintenance} LOCK_PATH [STALE_TTL_MINUTES|TOKEN]
#
# Actions:
#   acquire            — create lock directory atomically; reclaim if stale
#                        Outputs: ACQUIRED <token>  (pass token to refresh/release)
#   release [TOKEN]    — remove lock directory (verifies ownership if TOKEN given)
#   refresh [TOKEN]    — touch lock files to reset TTL clock (verifies ownership if TOKEN given)
#   check-maintenance  — check if .maintenance.lock exists in LOCK_PATH (workspace dir)
#
# The PID stored in the lock is best-effort: in execution models where each
# command runs in a short-lived shell (e.g., Claude Code's Bash tool), the PID
# will be dead by the time it's checked.  Use 'refresh' between long-running
# phases to keep the lock alive via TTL.
#
# Exit codes:
#   0 — success (ACQUIRED / RELEASED / REFRESHED / CLEAR)
#   1 — blocked (LOCKED / MAINTENANCE), ownership lost (STOLEN), or refresh failure (NO_LOCK)
#   2 — usage error
set -euo pipefail

usage() {
  echo "Usage: lock.sh {acquire|release|refresh|check-maintenance} LOCK_PATH [STALE_TTL_MINUTES|TOKEN]" >&2
  exit 2
}

ACTION="${1:-}"
LOCK_PATH="${2:-}"

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

# Validate PID: must be a positive integer (rejects negative, zero, non-numeric)
is_valid_pid() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

# Verify lock ownership by comparing tokens.
# Returns 0 (match) or 1 (mismatch).  If lock has no token file, returns 0
# (backward compat for locks created without token support).
verify_token() {
  local expected_token="$1"
  local token_file="$LOCK_PATH/token"
  if [ ! -f "$token_file" ]; then
    return 0
  fi
  local stored_token
  stored_token=$(cat "$token_file" 2>/dev/null || echo "")
  [ "$stored_token" = "$expected_token" ]
}

case "$ACTION" in
  acquire)
    STALE_TTL="${3:-60}"
    # Check for stale lock first
    if [ -d "$LOCK_PATH" ]; then
      lock_pid_file="$LOCK_PATH/pid"
      if [ -f "$lock_pid_file" ]; then
        lock_pid=$(cat "$lock_pid_file" 2>/dev/null || echo "")
        # If the lock-holding process is still alive, the lock is valid regardless of age
        if [ -n "$lock_pid" ] && is_valid_pid "$lock_pid" && kill -0 "$lock_pid" 2>/dev/null; then
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
      # Generate unique ownership token
      local_token=$(uuidgen 2>/dev/null || echo "$$-$(date +%s)")
      echo "$local_token" > "$LOCK_PATH/token"
      echo "ACQUIRED $local_token"
      exit 0
    else
      echo "LOCKED"
      exit 1
    fi
    ;;

  refresh)
    TOKEN="${3:-}"
    # Touch lock files to reset the TTL clock.
    # Call this between long-running phases to prevent stale-lock reclaim.
    if [ -d "$LOCK_PATH" ]; then
      if [ -n "$TOKEN" ] && ! verify_token "$TOKEN"; then
        echo "STOLEN"
        exit 1
      fi
      touch "$LOCK_PATH/pid" "$LOCK_PATH/timestamp" 2>/dev/null
      [ -f "$LOCK_PATH/token" ] && touch "$LOCK_PATH/token" 2>/dev/null
      echo "REFRESHED"
      exit 0
    else
      echo "NO_LOCK"
      exit 1
    fi
    ;;

  release)
    TOKEN="${3:-}"
    if [ -d "$LOCK_PATH" ]; then
      if [ -n "$TOKEN" ] && ! verify_token "$TOKEN"; then
        echo "STOLEN"
        exit 1
      fi
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
    echo "Usage: lock.sh {acquire|release|refresh|check-maintenance} LOCK_PATH [STALE_TTL_MINUTES|TOKEN]" >&2
    exit 2
    ;;
esac
