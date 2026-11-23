#!/usr/bin/env bash
set -euo pipefail

LABEL="com.t3code.copilot-idle-compact"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$REPO_DIR/bin/t3-copilot-idle-compact.mjs"
NODE_BIN="$(command -v node)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
LOG_PATH="$LOG_DIR/t3-copilot-idle-compact.log"

MIN_TOKENS="${T3_COMPACT_MIN_TOKENS:-150000}"
IDLE_MIN="${T3_COMPACT_IDLE_MIN_SEC:-240}"
IDLE_MAX="${T3_COMPACT_IDLE_MAX_SEC:-290}"
POLL_SEC="${T3_COMPACT_POLL_SEC:-15}"

if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found in PATH." >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>--no-warnings</string>
    <string>${ENTRY}</string>
    <string>--min-tokens</string>
    <string>${MIN_TOKENS}</string>
    <string>--idle-min</string>
    <string>${IDLE_MIN}</string>
    <string>--idle-max</string>
    <string>${IDLE_MAX}</string>
    <string>--poll</string>
    <string>${POLL_SEC}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):$HOME/.t3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed and started $LABEL"
echo "  Plist : $PLIST_PATH"
echo "  Logs  : $LOG_PATH"
