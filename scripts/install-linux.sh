#!/usr/bin/env bash
set -euo pipefail

SERVICE="t3-copilot-idle-compact.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$REPO_DIR/bin/t3-copilot-idle-compact.mjs"
NODE_BIN="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$SERVICE"

MIN_TOKENS="${T3_COMPACT_MIN_TOKENS:-200000}"
IDLE_MIN="${T3_COMPACT_IDLE_MIN_SEC:-240}"
IDLE_MAX="${T3_COMPACT_IDLE_MAX_SEC:-285}"
POLL_SEC="${T3_COMPACT_POLL_SEC:-15}"

if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found in PATH." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Auto-compact idle GitHub Copilot CLI threads in T3 Code
After=default.target

[Service]
Type=simple
ExecStart=${NODE_BIN} --no-warnings ${ENTRY} --min-tokens ${MIN_TOKENS} --idle-min ${IDLE_MIN} --idle-max ${IDLE_MAX} --poll ${POLL_SEC}
Restart=always
RestartSec=5
Environment=PATH=$(dirname "$NODE_BIN"):$HOME/.t3/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE"

echo "Installed and started $SERVICE"
echo "  Unit : $UNIT_PATH"
echo "  Logs : journalctl --user -u $SERVICE -f"
