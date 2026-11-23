import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  buildT3CliInvocation,
  resolveCopilotDbPath,
  resolveCopilotHome,
  resolveSettingsPath,
  resolveStateDbPath,
  resolveT3Cli,
  resolveT3Home,
  resolveWatcherStatePath,
} from "./paths.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_CONFIG = Object.freeze({
  minTokens: 150_000,
  idleMinSec: 240, // 4m00s
  idleMaxSec: 290, // 4m50s (before 5m00s prompt cache expiry)
  pollSec: 15,
  sendTimeoutMs: 30_000,
});

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "queued"]);
const PENDING_WORK_STATUSES = new Set(["pending", "starting", "running", "waiting"]);
const THREAD_ID_PATTERN = /^[A-Za-z0-9:._-]+$/;
const MAX_STATE_ENTRIES = 500;

export function parseJsonSafe(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Determine which T3 Code providerInstanceIds correspond to GitHub Copilot CLI.
 */
export function discoverCopilotInstances(settingsPath, explicitProviders = []) {
  if (Array.isArray(explicitProviders) && explicitProviders.length > 0) {
    return new Set(explicitProviders.map((p) => p.trim()).filter(Boolean));
  }

  const matched = new Set();
  if (!settingsPath || !fs.existsSync(settingsPath)) return matched;

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return matched;
  }

  const instances = settings?.providerInstances;
  if (!instances || typeof instances !== "object") return matched;

  for (const [instanceId, entry] of Object.entries(instances)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.enabled === false) continue;

    if (isCopilotProviderInstance(instanceId, entry)) {
      matched.add(instanceId);
    }
  }

  return matched;
}

export function isCopilotProviderInstance(instanceId, entry) {
  const driver = typeof entry.driver === "string" ? entry.driver : "";
  const config = entry.config && typeof entry.config === "object" ? entry.config : {};
  const agentId = typeof config.agentId === "string" ? config.agentId.trim().toLowerCase() : "";
  const commandPath = typeof config.commandPath === "string" ? config.commandPath.trim() : "";
  const commandBase = commandPath ? path.win32.basename(commandPath.replaceAll("/", "\\")) : "";

  if (driver === "copilot" || driver === "github-copilot") return true;

  if (driver === "acpRegistry") {
    if (agentId === "github-copilot-cli") return true;
    if (/^copilot(\.exe|\.cmd|\.bat)?$/i.test(commandBase)) return true;
    if (/copilot/i.test(instanceId)) return true;
    if (typeof entry.displayName === "string" && /copilot/i.test(entry.displayName)) return true;
  }

  return false;
}

export function openReadOnlyDb(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000;");
  } catch {
    // Some read-only environments may ignore PRAGMA busy_timeout; safe to continue.
  }
  return db;
}

/**
 * Read the most recent context token usage for a Copilot CLI session from
 * `~/.copilot/session-store.db` (`assistant_usage_events`).
 */
export function readCopilotSessionTokens(copilotDb, nativeSessionId) {
  if (!copilotDb || !nativeSessionId) return null;
  try {
    const row = copilotDb
      .prepare(
        `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         FROM assistant_usage_events
         WHERE session_id = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(nativeSessionId);

    if (!row) return null;

    const input = toFiniteNonNegInt(row.input_tokens);
    const cacheRead = toFiniteNonNegInt(row.cache_read_tokens);
    const cacheWrite = toFiniteNonNegInt(row.cache_write_tokens);
    const output = toFiniteNonNegInt(row.output_tokens);

    // Copilot CLI stores total prompt input in `input_tokens` (which can include or
    // complement cache tokens depending on backend). Taking max(input, cacheRead + cacheWrite)
    // plus output gives a conservative context footprint without double-counting.
    const promptTokens = Math.max(input, cacheRead + cacheWrite);
    const total = promptTokens + output;
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

function toFiniteNonNegInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Resolve token count for a thread from:
 *   1. T3 Code's `orchestration_v2_projection_provider_threads.payload_json` (`contextUsage.usedTokens`)
 *   2. T3 Code's latest `orchestration_v2_projection_provider_turns.payload_json` (`tokenUsage.usedTokens`)
 *   3. Fallback to Copilot CLI's `session-store.db` (`assistant_usage_events`) via `nativeThreadRef.nativeId`
 */
export function resolveThreadTokens(t3Db, copilotDb, providerThreadRow) {
  if (!providerThreadRow) return { usedTokens: null, maxTokens: null, source: "none", nativeSessionId: null };

  const ptPayload = parseJsonSafe(providerThreadRow.payload_json) ?? {};
  const nativeSessionId =
    typeof ptPayload?.nativeThreadRef?.nativeId === "string" && ptPayload.nativeThreadRef.nativeId.length > 0
      ? ptPayload.nativeThreadRef.nativeId
      : null;

  const ctxUsed = ptPayload?.contextUsage?.usedTokens;
  const ctxMax = ptPayload?.contextUsage?.maxTokens ?? null;
  if (typeof ctxUsed === "number" && Number.isFinite(ctxUsed) && ctxUsed > 0) {
    return { usedTokens: Math.floor(ctxUsed), maxTokens: ctxMax, source: "t3.contextUsage", nativeSessionId };
  }

  // Fallback 1: check latest provider_turn tokenUsage in statev2.sqlite
  try {
    const turnRows = t3Db
      .prepare(
        `SELECT payload_json
         FROM orchestration_v2_projection_provider_turns
         WHERE provider_thread_id = ?
         ORDER BY ordinal DESC
         LIMIT 5`,
      )
      .all(providerThreadRow.provider_thread_id);

    for (const tr of turnRows) {
      const tp = parseJsonSafe(tr.payload_json);
      const turnUsed = tp?.tokenUsage?.usedTokens;
      if (typeof turnUsed === "number" && Number.isFinite(turnUsed) && turnUsed > 0) {
        return {
          usedTokens: Math.floor(turnUsed),
          maxTokens: tp?.tokenUsage?.maxTokens ?? ctxMax,
          source: "t3.providerTurn",
          nativeSessionId,
        };
      }
    }
  } catch {
    // Table may not exist in older schemas; fall through.
  }

  // Fallback 2: Copilot CLI's own session-store.db
  if (nativeSessionId && copilotDb) {
    const copilotUsed = readCopilotSessionTokens(copilotDb, nativeSessionId);
    if (copilotUsed !== null) {
      return { usedTokens: copilotUsed, maxTokens: ctxMax, source: "copilot.sessionStore", nativeSessionId };
    }
  }

  return { usedTokens: null, maxTokens: ctxMax, source: "unknown", nativeSessionId };
}

/**
 * Evaluate all active threads belonging to Copilot CLI provider instances.
 */
export function evaluateThreads({
  t3Db,
  copilotDb,
  copilotInstances,
  state,
  config,
  nowMs = Date.now(),
}) {
  if (!t3Db || copilotInstances.size === 0) return [];

  const idleMinMs = config.idleMinSec * 1000;
  const idleMaxMs = config.idleMaxSec * 1000;

  const threadRows = t3Db
    .prepare(
      `SELECT thread_id, project_id, title, default_provider, provider_instance_id,
              active_provider_thread_id, updated_at, archived_at, deleted_at, payload_json
       FROM orchestration_v2_projection_threads
       WHERE deleted_at IS NULL AND archived_at IS NULL
       ORDER BY updated_at DESC`,
    )
    .all();

  const results = [];

  for (const row of threadRows) {
    const payload = parseJsonSafe(row.payload_json) ?? {};
    const providerInstanceId =
      row.provider_instance_id || payload.providerInstanceId || row.default_provider || "";

    if (!copilotInstances.has(providerInstanceId)) continue;

    // Skip subagent / child threads (only compact top-level threads)
    if (payload.lineage && payload.lineage.parentThreadId != null) continue;

    const base = {
      threadId: row.thread_id,
      title: row.title || "(untitled)",
      providerInstanceId,
      latestRunId: null,
      latestRunStatus: null,
      completedAt: null,
      idleMs: null,
      usedTokens: null,
      maxTokens: null,
      tokenSource: "none",
      nativeSessionId: null,
      eligible: false,
      reason: "",
    };

    if (payload.settledAt != null || payload.settledOverride === "settled") {
      results.push({ ...base, reason: "settled" });
      continue;
    }

    if (payload.snoozedUntil != null && Date.parse(payload.snoozedUntil) > nowMs) {
      results.push({ ...base, reason: "snoozed" });
      continue;
    }

    const runs = t3Db
      .prepare(
        `SELECT run_id, ordinal, status, provider_thread_id, provider_instance_id,
                requested_at, completed_at, payload_json
         FROM orchestration_v2_projection_runs
         WHERE thread_id = ?
         ORDER BY ordinal DESC`,
      )
      .all(row.thread_id);

    if (runs.length === 0) {
      results.push({ ...base, reason: "no_runs" });
      continue;
    }

    // Check if any run is active or queued
    const blockingRun = runs.find((r) => ACTIVE_RUN_STATUSES.has(r.status));
    if (blockingRun) {
      results.push({
        ...base,
        latestRunId: blockingRun.run_id,
        latestRunStatus: blockingRun.status,
        reason: `run_${blockingRun.status}`,
      });
      continue;
    }

    // Latest executed run (ignore runs cancelled before ever starting)
    const latestRun = runs.find((r) => {
      if (r.status !== "cancelled") return true;
      const rp = parseJsonSafe(r.payload_json);
      return rp?.startedAt != null;
    });

    if (!latestRun) {
      results.push({ ...base, reason: "no_executed_runs" });
      continue;
    }

    const latestRunPayload = parseJsonSafe(latestRun.payload_json) ?? {};
    base.latestRunId = latestRun.run_id;
    base.latestRunStatus = latestRun.status;
    base.completedAt = latestRun.completed_at;

    // Resolve provider thread & token info early so `--status` always shows it
    const activeProviderThreadId =
      row.active_provider_thread_id || payload.activeProviderThreadId || latestRun.provider_thread_id;

    let providerThreadRow = null;
    if (activeProviderThreadId) {
      providerThreadRow = t3Db
        .prepare(
          `SELECT provider_thread_id, status, provider_instance_id, payload_json
           FROM orchestration_v2_projection_provider_threads
           WHERE provider_thread_id = ?`,
        )
        .get(activeProviderThreadId);
    }

    const tokenInfo = resolveThreadTokens(t3Db, copilotDb, providerThreadRow);
    base.usedTokens = tokenInfo.usedTokens;
    base.maxTokens = tokenInfo.maxTokens;
    base.tokenSource = tokenInfo.source;
    base.nativeSessionId = tokenInfo.nativeSessionId;

    if (latestRun.status !== "completed" || !latestRun.completed_at) {
      results.push({ ...base, reason: `latest_run_${latestRun.status}` });
      continue;
    }

    const completedMs = Date.parse(latestRun.completed_at);
    if (!Number.isFinite(completedMs)) {
      results.push({ ...base, reason: "invalid_completed_at" });
      continue;
    }

    const idleMs = Math.max(0, nowMs - completedMs);
    base.idleMs = idleMs;

    // Ensure the latest run belongs to this Copilot provider instance
    const runProviderInstanceId =
      latestRun.provider_instance_id || latestRunPayload.providerInstanceId || providerInstanceId;
    if (runProviderInstanceId !== providerInstanceId) {
      results.push({ ...base, reason: "provider_mismatch" });
      continue;
    }

    // Check if the latest user message was already /compact (no infinite loops!)
    const userMessageId = latestRunPayload.userMessageId;
    if (typeof userMessageId === "string" && userMessageId.length > 0) {
      const msgRow = t3Db
        .prepare(
          `SELECT payload_json
           FROM orchestration_v2_projection_messages
           WHERE message_id = ?`,
        )
        .get(userMessageId);
      const msgPayload = parseJsonSafe(msgRow?.payload_json);
      const msgText = typeof msgPayload?.text === "string" ? msgPayload.text.trim().toLowerCase() : "";
      if (msgText === "/compact") {
        results.push({ ...base, reason: "already_compacted_last_turn" });
        continue;
      }
    }

    // Check persistent state guard (only compact once per idle period / run)
    if (state?.threads?.[row.thread_id]?.lastCompactedRunId === latestRun.run_id) {
      results.push({ ...base, reason: "already_dispatched_for_run" });
      continue;
    }

    // Check pending approvals / user input requests / subagents / merge-backs / running items
    if (hasPendingThreadWork(t3Db, row.thread_id)) {
      results.push({ ...base, reason: "pending_work_or_approval" });
      continue;
    }

    // Check token threshold
    if (base.usedTokens === null) {
      results.push({ ...base, reason: "unknown_token_usage" });
      continue;
    }
    if (base.usedTokens < config.minTokens) {
      results.push({ ...base, reason: `below_min_tokens(${base.usedTokens}<${config.minTokens})` });
      continue;
    }

    // Check idle window
    if (idleMs < idleMinMs) {
      results.push({ ...base, reason: `not_idle_yet(${Math.floor(idleMs / 1000)}s<${config.idleMinSec}s)` });
      continue;
    }
    if (idleMs > idleMaxMs) {
      results.push({ ...base, reason: `cache_expired(${Math.floor(idleMs / 1000)}s>${config.idleMaxSec}s)` });
      continue;
    }

    results.push({ ...base, eligible: true, reason: "eligible" });
  }

  return results;
}

function hasPendingThreadWork(t3Db, threadId) {
  try {
    const req = t3Db
      .prepare(
        `SELECT 1 FROM orchestration_v2_projection_runtime_requests
         WHERE thread_id = ? AND status = 'pending' LIMIT 1`,
      )
      .get(threadId);
    if (req) return true;
  } catch {
    // ignore missing table
  }

  try {
    const sub = t3Db
      .prepare(
        `SELECT status FROM orchestration_v2_projection_subagents
         WHERE thread_id = ?`,
      )
      .all(threadId);
    if (sub.some((s) => PENDING_WORK_STATUSES.has(s.status))) return true;
  } catch {
    // ignore missing table
  }

  try {
    const xfer = t3Db
      .prepare(
        `SELECT 1 FROM orchestration_v2_projection_context_transfers
         WHERE target_thread_id = ? AND type = 'merge_back' AND status = 'pending' LIMIT 1`,
      )
      .get(threadId);
    if (xfer) return true;
  } catch {
    // ignore missing table
  }

  try {
    const item = t3Db
      .prepare(
        `SELECT status FROM orchestration_v2_projection_turn_items
         WHERE thread_id = ? AND status IN ('pending', 'running', 'waiting') AND type <> 'todo_list' LIMIT 1`,
      )
      .get(threadId);
    if (item) return true;
  } catch {
    // ignore missing table
  }

  return false;
}

export function loadState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) {
    return { version: 1, threads: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.threads && typeof parsed.threads === "object") {
      return { version: 1, threads: parsed.threads };
    }
  } catch {
    // Corrupted state file; start fresh.
  }
  return { version: 1, threads: {} };
}

export function saveState(statePath, state) {
  if (!statePath) return;
  const entries = Object.entries(state.threads || {});
  if (entries.length > MAX_STATE_ENTRIES) {
    entries.sort((a, b) => Date.parse(b[1]?.compactedAt || 0) - Date.parse(a[1]?.compactedAt || 0));
    state.threads = Object.fromEntries(entries.slice(0, MAX_STATE_ENTRIES));
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, statePath);
}

/**
 * Dispatch `/compact` to a T3 Code thread using the official `t3 thread send` CLI.
 */
export async function dispatchCompact({
  t3Cli,
  t3Home,
  threadId,
  dryRun = false,
  timeoutMs = DEFAULT_CONFIG.sendTimeoutMs,
  platform = process.platform,
  execFileFn = execFileAsync,
}) {
  if (!THREAD_ID_PATTERN.test(threadId)) {
    throw new Error(`Refusing to dispatch invalid threadId: ${threadId}`);
  }

  const cliArgs = ["thread", "send"];
  if (t3Home) {
    cliArgs.push("--base-dir", t3Home);
  }
  cliArgs.push(threadId, "/compact");

  if (dryRun) {
    return { dispatched: false, dryRun: true, command: [t3Cli, ...cliArgs].join(" ") };
  }

  const invocation = buildT3CliInvocation(t3Cli, cliArgs, platform);
  const { stdout, stderr } = await execFileFn(invocation.command, invocation.args, {
    timeout: timeoutMs,
    windowsHide: invocation.windowsHide,
  });

  return {
    dispatched: true,
    dryRun: false,
    stdout: String(stdout || "").trim(),
    stderr: String(stderr || "").trim(),
  };
}

/**
 * Execute one full watcher poll sweep: inspect databases, evaluate threads,
 * and dispatch `/compact` for every eligible thread.
 */
export async function runSweep({
  t3Home = resolveT3Home(),
  copilotHome = resolveCopilotHome(),
  t3Cli,
  statePath,
  explicitProviders = [],
  config = DEFAULT_CONFIG,
  dryRun = false,
  inFlight = new Set(),
  nowMs = Date.now(),
  logger = console,
  verbose = false,
  execFileFn = execFileAsync,
} = {}) {
  const effectiveCli = resolveT3Cli(t3Home, t3Cli);
  const effectiveStatePath = resolveWatcherStatePath(t3Home, statePath);
  const stateDbPath = resolveStateDbPath(t3Home);
  const settingsPath = resolveSettingsPath(t3Home);
  const copilotDbPath = resolveCopilotDbPath(copilotHome);

  const copilotInstances = discoverCopilotInstances(settingsPath, explicitProviders);
  if (copilotInstances.size === 0) {
    if (verbose) {
      logger.log(`[${isoNow(nowMs)}] No enabled GitHub Copilot CLI provider instances found in ${settingsPath}`);
    }
    return { copilotInstances, evaluated: [], dispatched: [], errors: [] };
  }

  const state = loadState(effectiveStatePath);
  let t3Db = null;
  let copilotDb = null;
  let evaluated = [];

  try {
    t3Db = openReadOnlyDb(stateDbPath);
    if (!t3Db) {
      if (verbose) {
        logger.log(`[${isoNow(nowMs)}] T3 state database not found at ${stateDbPath}`);
      }
      return { copilotInstances, evaluated: [], dispatched: [], errors: [] };
    }

    copilotDb = openReadOnlyDb(copilotDbPath);
    evaluated = evaluateThreads({
      t3Db,
      copilotDb,
      copilotInstances,
      state,
      config,
      nowMs,
    });
  } finally {
    try {
      copilotDb?.close();
    } catch {
      // ignore close errors
    }
    try {
      t3Db?.close();
    } catch {
      // ignore close errors
    }
  }

  const dispatched = [];
  const errors = [];
  let stateDirty = false;

  for (const item of evaluated) {
    if (!item.eligible) {
      if (verbose) {
        logger.log(
          `[${isoNow(nowMs)}] skip thread=${item.threadId} title=${JSON.stringify(item.title)} tokens=${item.usedTokens ?? "?"} (${item.tokenSource}) idle=${formatDuration(item.idleMs)} reason=${item.reason}`,
        );
      }
      continue;
    }

    if (inFlight.has(item.threadId)) {
      if (verbose) {
        logger.log(`[${isoNow(nowMs)}] skip thread=${item.threadId} reason=dispatch_in_flight`);
      }
      continue;
    }

    inFlight.add(item.threadId);
    try {
      const result = await dispatchCompact({
        t3Cli: effectiveCli,
        t3Home,
        threadId: item.threadId,
        dryRun,
        timeoutMs: config.sendTimeoutMs,
        execFileFn,
      });

      if (dryRun) {
        logger.log(
          `[${isoNow(nowMs)}] [dry-run] would compact thread=${item.threadId} title=${JSON.stringify(item.title)} tokens=${item.usedTokens} (${item.tokenSource}) idle=${formatDuration(item.idleMs)} cmd="${result.command}"`,
        );
      } else {
        state.threads[item.threadId] = {
          lastCompactedRunId: item.latestRunId,
          compactedAt: new Date(nowMs).toISOString(),
          usedTokens: item.usedTokens,
          idleSec: Math.floor((item.idleMs ?? 0) / 1000),
        };
        stateDirty = true;
        logger.log(
          `[${isoNow(nowMs)}] compacted thread=${item.threadId} title=${JSON.stringify(item.title)} tokens=${item.usedTokens} (${item.tokenSource}) idle=${formatDuration(item.idleMs)} output=${JSON.stringify(result.stdout)}`,
        );
      }

      dispatched.push({ ...item, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `[${isoNow(nowMs)}] error compacting thread=${item.threadId} title=${JSON.stringify(item.title)}: ${message}`,
      );
      errors.push({ threadId: item.threadId, error: message });
    } finally {
      inFlight.delete(item.threadId);
    }
  }

  if (stateDirty) {
    saveState(effectiveStatePath, state);
  }

  return { copilotInstances, evaluated, dispatched, errors };
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

function isoNow(nowMs) {
  return new Date(nowMs).toISOString();
}
