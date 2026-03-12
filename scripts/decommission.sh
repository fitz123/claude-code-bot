#!/bin/bash
# Decommission OpenClaw gateway
# Stops the gateway service, moves plist to .disabled, preserves all data.
# Rollback: mv ~/Library/LaunchAgents/ai.openclaw.gateway.plist.disabled ~/Library/LaunchAgents/ai.openclaw.gateway.plist && launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
DISABLED="${PLIST}.disabled"
LABEL="ai.openclaw.gateway"
LOG_DIR="$HOME/.openclaw/logs"

echo "=== OpenClaw Gateway Decommission ==="
echo "Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# 1. Check if gateway is loaded
if launchctl print "gui/$(id -u)/$LABEL" &>/dev/null; then
    echo "[1/4] Gateway is running. Stopping..."
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    sleep 2

    # Verify stopped
    if launchctl print "gui/$(id -u)/$LABEL" &>/dev/null; then
        echo "ERROR: Gateway still running after bootout. Aborting."
        exit 1
    fi
    echo "      Gateway stopped successfully."
else
    echo "[1/4] Gateway is not running. Skipping stop."
fi

# 2. Move plist to .disabled (not delete)
if [ -f "$PLIST" ]; then
    echo "[2/4] Moving plist to ${DISABLED}..."
    mv "$PLIST" "$DISABLED"
    echo "      Plist moved. To rollback:"
    echo "      mv '$DISABLED' '$PLIST' && launchctl load '$PLIST'"
else
    echo "[2/4] Plist not found at $PLIST. Already moved?"
fi

# 3. Preserve config and data (just verify they exist)
echo "[3/4] Verifying preserved files..."
for f in "$HOME/.openclaw/openclaw.json" "$LOG_DIR/gateway.log" "$LOG_DIR/gateway.err.log"; do
    if [ -f "$f" ]; then
        echo "      OK: $f ($(wc -c < "$f" | tr -d ' ') bytes)"
    else
        echo "      WARN: $f not found"
    fi
done

# 4. Verify new bot is running
echo "[4/4] Verifying new Telegram bot..."
if launchctl print "gui/$(id -u)/ai.openclaw.telegram-bot" &>/dev/null; then
    echo "      New bot is running. OK."
else
    echo "      WARNING: New Telegram bot is NOT running!"
    echo "      Start it: launchctl load ~/Library/LaunchAgents/ai.openclaw.telegram-bot.plist"
fi

echo ""
echo "=== Decommission complete ==="
echo "Gateway stopped and plist disabled."
echo "Config/logs/data preserved at ~/.openclaw/"
echo "DO NOT uninstall OpenClaw for 2 weeks (rollback option)."
echo ""
echo "Rollback command:"
echo "  mv '$DISABLED' '$PLIST' && launchctl load '$PLIST'"
