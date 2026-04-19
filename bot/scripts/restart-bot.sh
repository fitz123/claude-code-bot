#!/bin/bash
# restart-bot.sh — Safely restart the Telegram bot launchd service
# Usage:
#   restart-bot.sh              Graceful SIGTERM restart (code / config.yaml changes)
#   restart-bot.sh --plist      Full unregister + re-bootstrap (plist-on-disk changes)
#   restart-bot.sh -h|--help    Show this help
#
# Never sends SIGKILL. Validates config before restarting. Polls launchd
# teardown so bootout is not raced against bootstrap.

set -euo pipefail

export HOME="${HOME:-$(dscl . -read "/Users/$(whoami)" NFSHomeDirectory | awk '{print $2}')}"
if [ -z "$HOME" ]; then
  echo "[restart-bot] Error: could not determine HOME (dscl fallback returned empty)" >&2
  exit 1
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-/bin/launchctl}"
BOT_LABEL="${BOT_LABEL:-ai.minime.telegram-bot}"
BOT_PLIST="${BOT_PLIST:-$HOME/Library/LaunchAgents/${BOT_LABEL}.plist}"
BOT_UID="${BOT_UID:-$(id -u)}"
DOMAIN="gui/${BOT_UID}"
SERVICE="${DOMAIN}/${BOT_LABEL}"

# Test-only: override the validator with a single executable (no args, no eval).
# Tests set this to `true` / `false` to simulate validation pass / fail paths.
CONFIG_VALIDATE_BIN="${CONFIG_VALIDATE_BIN:-}"

# Timeouts (seconds). Drain window is 60s — give headroom.
SHUTDOWN_TIMEOUT="${SHUTDOWN_TIMEOUT:-90}"
TEARDOWN_TIMEOUT="${TEARDOWN_TIMEOUT:-90}"
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-60}"
POLL_INTERVAL="${POLL_INTERVAL:-1}"

usage() {
  cat <<EOF
Usage:
  restart-bot.sh              Graceful SIGTERM restart (code / config.yaml changes)
  restart-bot.sh --plist      Full unregister + re-bootstrap (plist-on-disk changes)
  restart-bot.sh -h|--help    Show this help

On success: prints new PID and exits 0.
On failure: prints a diagnostic and exits non-zero.
EOF
}

log() { echo "[restart-bot] $*"; }
err() { echo "[restart-bot] Error: $*" >&2; }

MODE="graceful"

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --plist) MODE="plist"; shift ;;
    *) err "unknown argument: $1"; usage >&2; exit 2 ;;
  esac
done

# get_pid prints one of:
#   <numeric pid> — service is registered and running
#   ""            — service is registered but has no running process (PID = "-")
# exit status:
#   0 — registered (pid may be empty)
#   1 — not registered (launchctl query succeeded, label absent)
#   2 — launchctl query itself failed (unknown state)
get_pid() {
  local out
  if ! out=$("$LAUNCHCTL_BIN" list 2>/dev/null); then
    return 2
  fi
  local line
  line=$(printf '%s\n' "$out" | awk -v L="$BOT_LABEL" '$3==L { print; exit }')
  if [ -z "$line" ]; then
    return 1
  fi
  local pid
  pid=$(printf '%s\n' "$line" | awk '{print $1}')
  if [ "$pid" = "-" ]; then
    echo ""
  else
    echo "$pid"
  fi
  return 0
}

# True only when launchctl query succeeded AND the service is registered.
# A transient query failure is NOT treated as "registered" or "not registered".
is_registered() {
  local rc=0
  get_pid >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 0 ]
}

wait_until() {
  # wait_until <timeout_seconds> <predicate_fn>
  local timeout="$1"; local pred="$2"
  local deadline
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$pred"; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  return 1
}

_old_pid=""
_pred_old_pid_gone() {
  local cur rc=0
  cur=$(get_pid 2>/dev/null) || rc=$?
  case "$rc" in
    0) [ "$cur" != "$_old_pid" ] ;;
    1) return 0 ;;   # explicitly not registered → old pid gone
    *) return 1 ;;   # query failed → unknown, keep polling
  esac
}

# Distinguishes "confirmed not registered" from "query failed", so a transient
# launchctl error can't trick us into bootstrapping over a still-registered svc.
_pred_unregistered() {
  local rc=0
  get_pid >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 1 ]
}

# Requires a successful query AND a non-empty PID that differs from the old PID,
# so a stale `launchctl list` response can't be mistaken for the new process.
_pred_running_pid() {
  local pid rc=0
  pid=$(get_pid 2>/dev/null) || rc=$?
  [ "$rc" -eq 0 ] && [ -n "$pid" ] && [ "$pid" != "$_old_pid" ]
}

validate_config() {
  log "Validating config before restart…"
  if [ -n "$CONFIG_VALIDATE_BIN" ]; then
    if ! ( cd "$BOT_DIR" && "$CONFIG_VALIDATE_BIN" >/dev/null 2>&1 ); then
      err "config validation failed; refusing to restart"
      return 1
    fi
    return 0
  fi
  if ! ( cd "$BOT_DIR" && npx tsx src/config.ts --validate >/dev/null ); then
    err "config validation failed; refusing to restart"
    return 1
  fi
}

graceful_restart() {
  local old_pid
  if ! old_pid=$(get_pid); then
    err "service $BOT_LABEL is not registered with launchd; run: restart-bot.sh --plist"
    return 1
  fi

  if [ -z "$old_pid" ]; then
    err "service $BOT_LABEL is registered but has no running process (PID=-); run: restart-bot.sh --plist"
    return 1
  fi

  validate_config || return 1

  log "Sending SIGTERM to $SERVICE (old PID: $old_pid)"
  if ! "$LAUNCHCTL_BIN" kill SIGTERM "$SERVICE"; then
    err "launchctl kill SIGTERM failed"
    return 1
  fi

  _old_pid="$old_pid"
  log "Waiting up to ${SHUTDOWN_TIMEOUT}s for old process $old_pid to exit…"
  if ! wait_until "$SHUTDOWN_TIMEOUT" _pred_old_pid_gone; then
    err "old process $old_pid did not exit within ${SHUTDOWN_TIMEOUT}s"
    return 1
  fi

  log "Waiting up to ${STARTUP_TIMEOUT}s for KeepAlive to spawn a new PID…"
  if ! wait_until "$STARTUP_TIMEOUT" _pred_running_pid; then
    err "no new PID observed within ${STARTUP_TIMEOUT}s; KeepAlive did not restart"
    return 1
  fi

  local new_pid
  new_pid=$(get_pid 2>/dev/null || true)
  log "Restart complete. New PID: ${new_pid:-unknown}"
  echo "$new_pid"
}

plist_restart() {
  if [ ! -f "$BOT_PLIST" ]; then
    err "plist not found: $BOT_PLIST"
    return 1
  fi

  validate_config || return 1

  if is_registered; then
    log "Unregistering $SERVICE (launchctl bootout)…"
    # bootout may return non-zero even when the teardown is in progress;
    # we rely on polling below, not the exit code.
    "$LAUNCHCTL_BIN" bootout "$SERVICE" >/dev/null 2>&1 || true

    log "Waiting up to ${TEARDOWN_TIMEOUT}s for teardown to complete…"
    if ! wait_until "$TEARDOWN_TIMEOUT" _pred_unregistered; then
      err "service did not unregister within ${TEARDOWN_TIMEOUT}s; refusing to bootstrap"
      err "bootout is still draining sessions — rerun once 'launchctl list' no longer shows $BOT_LABEL"
      return 1
    fi
  else
    log "Service not currently registered; skipping bootout."
  fi

  log "Bootstrapping from $BOT_PLIST…"
  if ! "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$BOT_PLIST"; then
    err "launchctl bootstrap failed"
    return 1
  fi

  log "Waiting up to ${STARTUP_TIMEOUT}s for a running PID…"
  if ! wait_until "$STARTUP_TIMEOUT" _pred_running_pid; then
    err "service registered but no running PID within ${STARTUP_TIMEOUT}s"
    return 1
  fi

  local new_pid
  new_pid=$(get_pid 2>/dev/null || true)
  log "Restart complete. New PID: ${new_pid:-unknown}"
  echo "$new_pid"
}

case "$MODE" in
  graceful) graceful_restart ;;
  plist)    plist_restart ;;
  *)        err "internal: unhandled mode $MODE"; exit 1 ;;
esac
