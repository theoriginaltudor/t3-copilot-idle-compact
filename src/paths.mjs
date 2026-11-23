import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve T3 Code's base data directory across macOS, Windows, and Linux.
 */
export function resolveT3Home(override, env = process.env, homedir = os.homedir()) {
  const value = override || env.T3CODE_HOME;
  if (value) return path.resolve(expandHome(value, homedir));
  return path.join(homedir, ".t3");
}

/**
 * Resolve GitHub Copilot CLI's home directory across macOS, Windows, and Linux.
 */
export function resolveCopilotHome(override, env = process.env, homedir = os.homedir()) {
  const value = override || env.COPILOT_HOME;
  if (value) return path.resolve(expandHome(value, homedir));
  return path.join(homedir, ".copilot");
}

export function resolveStateDbPath(t3Home) {
  return path.join(t3Home, "userdata", "statev2.sqlite");
}

export function resolveSettingsPath(t3Home) {
  return path.join(t3Home, "userdata", "settings.json");
}

export function resolveCopilotDbPath(copilotHome) {
  return path.join(copilotHome, "session-store.db");
}

export function resolveWatcherStatePath(t3Home, override, env = process.env, homedir = os.homedir()) {
  const value = override || env.T3_COMPACT_STATE_FILE;
  if (value) return path.resolve(expandHome(value, homedir));
  return path.join(t3Home, "userdata", "copilot-idle-compact-state.json");
}

/**
 * Locate the `t3` CLI binary across macOS, Windows, and Linux.
 */
export function resolveT3Cli(
  t3Home,
  override,
  { env = process.env, platform = process.platform, existsSync = fs.existsSync } = {},
) {
  const explicit = override || env.T3_CLI || env.T3CODE_CLI_PATH;
  if (explicit) return explicit;

  const binDir = path.join(t3Home, "bin");
  const candidates =
    platform === "win32"
      ? [
          path.join(binDir, "t3.exe"),
          path.join(binDir, "t3.cmd"),
          path.join(binDir, "t3.bat"),
          path.join(binDir, "t3"),
          ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "T3Code", "bin", "t3.exe")] : []),
        ]
      : [
          path.join(binDir, "t3"),
          "/opt/homebrew/bin/t3",
          "/usr/local/bin/t3",
        ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return platform === "win32" ? "t3.cmd" : "t3";
}

/**
 * Build safe execFile options for invoking the `t3` CLI on Windows (.cmd/.bat) and POSIX.
 */
export function buildT3CliInvocation(cliPath, args, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(cliPath)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", cliPath, ...args],
      windowsHide: true,
    };
  }
  return {
    command: cliPath,
    args,
    windowsHide: true,
  };
}

function expandHome(input, homedir) {
  if (input === "~") return homedir;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homedir, input.slice(2));
  }
  return input;
}
