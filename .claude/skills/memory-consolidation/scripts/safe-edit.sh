#!/bin/bash
# Safe file editing with backup/verify/rollback.
# Usage: safe-edit.sh {backup|verify|rollback|clean} FILEPATH
#
# Actions:
#   backup   — copy FILEPATH to FILEPATH.consolidation-backup
#   verify   — check file exists, is non-empty, and hasn't shrunk suspiciously
#   rollback — restore FILEPATH from backup, then remove backup
#   clean    — remove backup file after successful edit
#
# Exit codes:
#   0 — success
#   1 — verification or operation failure
#   2 — usage error
set -euo pipefail

usage() {
  echo "Usage: safe-edit.sh {backup|verify|rollback|clean} FILEPATH" >&2
  exit 2
}

ACTION="${1:-}"
FILEPATH="${2:-}"

[ -z "$ACTION" ] && usage
[ -z "$FILEPATH" ] && usage

BACKUP_PATH="${FILEPATH}.consolidation-backup"

# Portable file size in bytes
file_size_bytes() {
  wc -c < "$1" | tr -d ' '
}

case "$ACTION" in
  backup)
    if [ -f "$FILEPATH" ]; then
      cp "$FILEPATH" "$BACKUP_PATH"
      echo "BACKED_UP"
    else
      echo "NO_FILE"
      exit 1
    fi
    ;;

  verify)
    if [ ! -f "$FILEPATH" ]; then
      echo "MISSING"
      exit 1
    fi

    size=$(file_size_bytes "$FILEPATH")
    if [ "$size" -eq 0 ]; then
      echo "EMPTY"
      exit 1
    fi

    # If backup exists, check file didn't shrink to less than 20% of original
    if [ -f "$BACKUP_PATH" ]; then
      backup_size=$(file_size_bytes "$BACKUP_PATH")
      if [ "$backup_size" -gt 0 ]; then
        threshold=$(( backup_size / 5 ))
        if [ "$size" -lt "$threshold" ]; then
          echo "SUSPICIOUS_SHRINK"
          exit 1
        fi
      fi
    fi

    echo "VERIFIED"
    ;;

  rollback)
    if [ -f "$BACKUP_PATH" ]; then
      cp "$BACKUP_PATH" "$FILEPATH"
      # Verify copy succeeded before removing backup
      backup_size=$(wc -c < "$BACKUP_PATH" | tr -d ' ')
      restored_size=$(wc -c < "$FILEPATH" | tr -d ' ')
      if [ "$backup_size" != "$restored_size" ]; then
        echo "ROLLBACK_COPY_FAILED"
        exit 1
      fi
      rm -f "$BACKUP_PATH"
      echo "ROLLED_BACK"
    else
      echo "NO_BACKUP"
      exit 1
    fi
    ;;

  clean)
    rm -f "$BACKUP_PATH"
    echo "CLEANED"
    ;;

  *)
    echo "Unknown action: $ACTION" >&2
    echo "Usage: safe-edit.sh {backup|verify|rollback|clean} FILEPATH" >&2
    exit 2
    ;;
esac
