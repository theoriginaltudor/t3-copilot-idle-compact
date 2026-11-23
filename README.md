# t3-copilot-idle-compact

Automatically triggers `/compact` on idle **GitHub Copilot CLI** threads in **[T3 Code](https://t3.codes)** after **4 minutes of inactivity**—while the 5-minute prompt cache is still warm.

Zero external dependencies. Cross-platform (**macOS**, **Windows**, and **Linux**) using Node.js built-in `node:sqlite`.

---

## Why This Exists

When you keep long T3 Code threads (~200k–1M context) open and step away for >5 minutes (meetings, context-switching), the 5-minute prompt cache expires. Your very next message pays a massive **cold cache write** across the full context.

- **Claude Code** already handles this natively (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` / T3 Code's built-in `IdleCompactionService`).
- **GitHub Copilot CLI** only auto-compacts by context percentage (`80%` / `95%`), not on an idle timer—and T3 Code's built-in `IdleCompactionService` currently only targets `claudeAgent`.

`t3-copilot-idle-compact` closes that gap without forking T3 Code.

---

## How It Works

1. Polls T3 Code's local SQLite state (`~/.t3/userdata/statev2.sqlite`, opened strictly **read-only** and closed after each sweep so WAL checkpointing is never blocked).
2. Auto-detects enabled GitHub Copilot CLI provider instances from `~/.t3/userdata/settings.json` (`acpRegistry` instances with `agentId: "github-copilot-cli"`, `copilot` executable, or Copilot instance ID).
3. Reads context token usage from T3 Code's `provider_threads` (`contextUsage.usedTokens`) with automatic fallback to Copilot CLI's `~/.copilot/session-store.db` (`assistant_usage_events`).
4. For each top-level Copilot thread, sends `/compact` via the official `t3 thread send <threadId> /compact` CLI **only if all guards pass**:
   - Context size `>= 150,000` tokens (configurable)
   - Idle for **`4m00s`–`4m50s`** (`240s`–`290s`) — never compacts after the 5m cache has already gone cold (e.g., after sleep/restart)
   - Latest run is `completed` with no active or queued runs
   - No pending approval/user-input requests, subagents, merge-backs, or running turn items
   - Not archived, deleted, settled, or snoozed
   - Latest turn was **not** already `/compact` **and** this `(threadId, latestRunId)` hasn't already been compacted (persisted across restarts to prevent loops)

---

## Requirements

- **Node.js `>= 22.5.0`** (uses built-in `node:sqlite` — no `npm install` needed)
- **T3 Code** installed with the `t3` CLI (`~/.t3/bin/t3` on macOS/Linux, `%USERPROFILE%\.t3\bin\t3.exe` or `t3.cmd` on Windows)
- **GitHub Copilot CLI** configured as a provider in T3 Code

---

## Quick Start

```bash
git clone https://github.com/theoriginaltudor/t3-copilot-idle-compact.git
cd t3-copilot-idle-compact

# Inspect detected Copilot threads, token counts, and eligibility
node ./bin/t3-copilot-idle-compact.mjs --status

# Dry-run one sweep (logs what would be compacted without sending /compact)
node ./bin/t3-copilot-idle-compact.mjs --once --dry-run --verbose

# Run interactively in the foreground
node ./bin/t3-copilot-idle-compact.mjs
```

---

## Run in the Background

### macOS (`launchd` LaunchAgent)

```bash
./scripts/install-macos.sh
# View logs
tail -f ~/Library/Logs/t3-copilot-idle-compact.log
# Uninstall
./scripts/uninstall-macos.sh
```

### Windows (Scheduled Task — hidden, no console flash)

Run in PowerShell:

```powershell
.\scripts\install-windows.ps1
# Custom threshold / window example:
.\scripts\install-windows.ps1 -MinTokens 150000 -IdleMinSec 240 -IdleMaxSec 290 -PollSec 15

# View logs
Get-Content "$env:LOCALAPPDATA\t3-copilot-idle-compact\watcher.log" -Wait

# Uninstall
.\scripts\uninstall-windows.ps1
```

### Linux (`systemd --user`)

```bash
./scripts/install-linux.sh
# View logs
journalctl --user -u t3-copilot-idle-compact.service -f
# Uninstall
./scripts/uninstall-linux.sh
```

---

## Configuration

Every option can be passed as a CLI flag or environment variable:

| Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--min-tokens <n>` | `T3_COMPACT_MIN_TOKENS` | `150000` | Minimum context tokens before compacting |
| `--idle-min <sec>` | `T3_COMPACT_IDLE_MIN_SEC` | `240` | Minimum idle time in seconds (`4m00s`) |
| `--idle-max <sec>` | `T3_COMPACT_IDLE_MAX_SEC` | `290` | Maximum idle time in seconds (`4m50s`, skips cold cache) |
| `--poll <sec>` | `T3_COMPACT_POLL_SEC` | `15` | Poll interval in seconds |
| `--providers <csv>` | `T3_COMPACT_PROVIDERS` | auto | Comma-separated T3 `providerInstanceId`s to monitor |
| `--t3-home <dir>` | `T3CODE_HOME` | `~/.t3` | T3 Code data directory |
| `--copilot-home <dir>` | `COPILOT_HOME` | `~/.copilot` | GitHub Copilot CLI home directory |
| `--t3-cli <path>` | `T3_CLI` | auto | Explicit path to the `t3` CLI binary |
| `--state-file <path>` | `T3_COMPACT_STATE_FILE` | `~/.t3/userdata/copilot-idle-compact-state.json` | Persistent dedupe state file |
| `--status` | — | `false` | Print all active Copilot threads & eligibility and exit |
| `--once` | — | `false` | Run one sweep and exit |
| `--dry-run` | — | `false` | Evaluate and log without sending `/compact` |
| `-v`, `--verbose` | — | `false` | Log skipped threads on every sweep |

---

## Testing

```bash
npm test
```

## Contributing

Pull requests are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and PR guidelines.

## License

MIT
