#!/usr/bin/env bash
set -euo pipefail

SERVICE="t3-copilot-idle-compact.service"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE"

systemctl --user disable --now "$SERVICE" 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl --user daemon-reload

echo "Uninstalled $SERVICE"
