#!/usr/bin/env bash
set -euo pipefail

LABEL="com.t3code.copilot-idle-compact"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_PATH"

echo "Uninstalled $LABEL"
