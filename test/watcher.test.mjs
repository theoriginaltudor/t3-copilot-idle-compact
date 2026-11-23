import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { buildT3CliInvocation, resolveT3Cli } from "../src/paths.mjs";
import {
  DEFAULT_CONFIG,
  discoverCopilotInstances,
  evaluateThreads,
  isCopilotProviderInstance,
  loadState,
  runSweep,
  saveState,
} from "../src/watcher.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3-compact-test-"));
}

function createT3Schema(db) {
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      default_provider TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      active_provider_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      payload_json TEXT NOT NULL,
      provider_instance_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY,
      thread_id TEXT,
      owner_node_id TEXT,
      provider TEXT NOT NULL,
      provider_session_id TEXT,
      status TEXT NOT NULL,
      first_run_ordinal INTEGER,
      last_run_ordinal INTEGER,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      driver TEXT,
      provider_instance_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      run_attempt_id TEXT,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      payload_json TEXT NOT NULL,
      provider_instance_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      role TEXT NOT NULL,
      streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      search_text TEXT
    );
    CREATE TABLE orchestration_v2_projection_runtime_requests (
      runtime_request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      provider_turn_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      parent_node_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT,
      child_thread_id TEXT,
      origin TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      driver TEXT,
      provider_instance_id TEXT,
      completion_delivery_state TEXT
    );
    CREATE TABLE orchestration_v2_projection_context_transfers (
      context_transfer_id TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      target_run_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      source_provider TEXT,
      target_provider TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_turn_items (
      item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      provider_thread_id TEXT,
      provider_turn_id TEXT,
      parent_item_id TEXT,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
}

function createCopilotSchema(db) {
  db.exec(`
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_index INTEGER,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function seedCopilotThread(
  t3Db,
  {
    threadId = "thread-1",
    title = "Long Copilot Thread",
    providerInstanceId = "github-copilot",
    runId = `run-${threadId}`,
    runStatus = "completed",
    completedAt = "2026-11-23T02:00:00.000Z",
    userMessageText = "Implement feature X",
    usedTokens = 210_000,
    nativeSessionId = "copilot-sess-1",
    threadPayloadExtra = {},
  } = {},
) {
  const ptId = `pt-${threadId}`;
  const msgId = `msg-${runId}`;

  t3Db
    .prepare(
      `INSERT INTO orchestration_v2_projection_threads
       (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json, provider_instance_id)
       VALUES (?, 'proj-1', ?, 'acpRegistry', 'full-access', 'default', ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      threadId,
      title,
      ptId,
      completedAt,
      completedAt,
      JSON.stringify({
        id: threadId,
        providerInstanceId,
        activeProviderThreadId: ptId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        settledAt: null,
        settledOverride: null,
        snoozedUntil: null,
        ...threadPayloadExtra,
      }),
      providerInstanceId,
    );

  t3Db
    .prepare(
      `INSERT INTO orchestration_v2_projection_provider_threads
       (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status,
        first_run_ordinal, last_run_ordinal, updated_at, payload_json, driver, provider_instance_id)
       VALUES (?, ?, NULL, 'acpRegistry', 'sess-1', 'idle', 1, 1, ?, ?, 'acpRegistry', ?)`,
    )
    .run(
      ptId,
      threadId,
      completedAt,
      JSON.stringify({
        id: ptId,
        nativeThreadRef: nativeSessionId ? { driver: "acpRegistry", nativeId: nativeSessionId } : null,
        contextUsage: usedTokens === null ? null : { usedTokens, maxTokens: 1_000_000 },
      }),
      providerInstanceId,
    );

  t3Db
    .prepare(
      `INSERT INTO orchestration_v2_projection_runs
       (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json, provider_instance_id)
       VALUES (?, ?, 1, 'acpRegistry', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      threadId,
      ptId,
      runStatus,
      completedAt,
      completedAt,
      JSON.stringify({
        id: runId,
        providerInstanceId,
        userMessageId: msgId,
        startedAt: completedAt,
      }),
      providerInstanceId,
    );

  t3Db
    .prepare(
      `INSERT INTO orchestration_v2_projection_messages
       (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json, search_text)
       VALUES (?, ?, ?, 'node-1', 'user', 0, ?, ?, ?, ?)`,
    )
    .run(
      msgId,
      threadId,
      runId,
      completedAt,
      completedAt,
      JSON.stringify({ id: msgId, role: "user", text: userMessageText }),
      userMessageText,
    );
}

describe("provider discovery & cross-platform paths", () => {
  it("recognizes registry, local binary, Windows .exe/.cmd, and displayName Copilot instances", () => {
    assert.equal(
      isCopilotProviderInstance("github-copilot", {
        driver: "acpRegistry",
        config: { source: "registry", agentId: "github-copilot-cli" },
      }),
      true,
    );
    assert.equal(
      isCopilotProviderInstance("work-acp", {
        driver: "acpRegistry",
        config: { source: "local", commandPath: "C:\\Tools\\copilot.exe" },
      }),
      true,
    );
    assert.equal(
      isCopilotProviderInstance("antigravity", {
        driver: "antigravity",
        enabled: true,
      }),
      false,
    );
  });

  it("discovers only enabled Copilot instances from settings.json", () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        providerInstances: {
          antigravity: { driver: "antigravity", enabled: true },
          "github-copilot": {
            driver: "acpRegistry",
            enabled: true,
            config: { source: "local", agentId: "github-copilot-cli", commandPath: "/opt/homebrew/bin/copilot" },
          },
          "copilot-disabled": {
            driver: "acpRegistry",
            enabled: false,
            config: { source: "registry", agentId: "github-copilot-cli" },
          },
        },
      }),
    );

    const found = discoverCopilotInstances(settingsPath);
    assert.deepEqual([...found], ["github-copilot"]);
  });

  it("builds Windows .cmd invocation via cmd.exe and POSIX invocation directly", () => {
    const winCmd = buildT3CliInvocation("C:\\Users\\dev\\.t3\\bin\\t3.cmd", ["thread", "send", "t1", "/compact"], "win32");
    assert.equal(winCmd.args[0], "/d");
    assert.equal(winCmd.args[3], "C:\\Users\\dev\\.t3\\bin\\t3.cmd");

    const posix = buildT3CliInvocation("/Users/dev/.t3/bin/t3", ["thread", "send", "t1", "/compact"], "darwin");
    assert.equal(posix.command, "/Users/dev/.t3/bin/t3");
    assert.deepEqual(posix.args, ["thread", "send", "t1", "/compact"]);

    const resolvedWin = resolveT3Cli("C:\\Users\\dev\\.t3", undefined, {
      platform: "win32",
      env: {},
      existsSync: (p) => p.endsWith("t3.exe"),
    });
    assert.ok(resolvedWin.endsWith("t3.exe"));
  });
});

describe("evaluateThreads guards", () => {
  const completedAt = "2026-11-23T02:00:00.000Z";
  const completedMs = Date.parse(completedAt);
  const instances = new Set(["github-copilot"]);

  it("marks a thread eligible inside the 4m00s..4m50s window when tokens >= 150k", () => {
    const t3Db = new DatabaseSync(":memory:");
    createT3Schema(t3Db);
    seedCopilotThread(t3Db, { completedAt, usedTokens: 200_000 });

    const res = evaluateThreads({
      t3Db,
      copilotDb: null,
      copilotInstances: instances,
      state: { version: 1, threads: {} },
      config: DEFAULT_CONFIG,
      nowMs: completedMs + 250_000, // 4m10s
    });

    assert.equal(res.length, 1);
    assert.equal(res[0].eligible, true);
    assert.equal(res[0].reason, "eligible");
    assert.equal(res[0].usedTokens, 200_000);
    t3Db.close();
  });

  it("falls back to ~/.copilot/session-store.db when T3 contextUsage is absent", () => {
    const t3Db = new DatabaseSync(":memory:");
    const copilotDb = new DatabaseSync(":memory:");
    createT3Schema(t3Db);
    createCopilotSchema(copilotDb);

    seedCopilotThread(t3Db, { completedAt, usedTokens: null, nativeSessionId: "sess-abc" });
    copilotDb
      .prepare(
        `INSERT INTO assistant_usage_events (session_id, turn_index, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES ('sess-abc', 4, 'claude-sonnet-4.5', 180000, 1200, 170000, 0)`,
      )
      .run();

    const res = evaluateThreads({
      t3Db,
      copilotDb,
      copilotInstances: instances,
      state: { version: 1, threads: {} },
      config: DEFAULT_CONFIG,
      nowMs: completedMs + 245_000,
    });

    assert.equal(res[0].eligible, true);
    assert.equal(res[0].usedTokens, 181_200);
    assert.equal(res[0].tokenSource, "copilot.sessionStore");
    t3Db.close();
    copilotDb.close();
  });

  it("skips threads below minTokens, not idle enough, or past cache expiry", () => {
    const t3Db = new DatabaseSync(":memory:");
    createT3Schema(t3Db);
    seedCopilotThread(t3Db, { threadId: "t-small", completedAt, usedTokens: 90_000 });
    seedCopilotThread(t3Db, { threadId: "t-big", completedAt, usedTokens: 300_000 });

    // Too early (3m00s)
    const early = evaluateThreads({
      t3Db,
      copilotDb: null,
      copilotInstances: instances,
      state: { version: 1, threads: {} },
      config: DEFAULT_CONFIG,
      nowMs: completedMs + 180_000,
    });
    assert.equal(early.find((x) => x.threadId === "t-small").eligible, false);
    assert.match(early.find((x) => x.threadId === "t-small").reason, /^below_min_tokens/);
    assert.equal(early.find((x) => x.threadId === "t-big").eligible, false);
    assert.match(early.find((x) => x.threadId === "t-big").reason, /^not_idle_yet/);

    // Past cache expiry (5m10s)
    const expired = evaluateThreads({
      t3Db,
      copilotDb: null,
      copilotInstances: instances,
      state: { version: 1, threads: {} },
      config: DEFAULT_CONFIG,
      nowMs: completedMs + 310_000,
    });
    assert.equal(expired.find((x) => x.threadId === "t-big").eligible, false);
    assert.match(expired.find((x) => x.threadId === "t-big").reason, /^cache_expired/);
    t3Db.close();
  });

  it("prevents infinite loops via both /compact message check and persistent runId state", () => {
    const t3Db = new DatabaseSync(":memory:");
    createT3Schema(t3Db);
    seedCopilotThread(t3Db, { threadId: "t-last-compact", completedAt, userMessageText: "/compact" });
    seedCopilotThread(t3Db, { threadId: "t-already-sent", runId: "run-42", completedAt, userMessageText: "fix bug" });

    const res = evaluateThreads({
      t3Db,
      copilotDb: null,
      copilotInstances: instances,
      state: { version: 1, threads: { "t-already-sent": { lastCompactedRunId: "run-42" } } },
      config: DEFAULT_CONFIG,
      nowMs: completedMs + 250_000,
    });

    assert.equal(res.find((x) => x.threadId === "t-last-compact").reason, "already_compacted_last_turn");
    assert.equal(res.find((x) => x.threadId === "t-already-sent").reason, "already_dispatched_for_run");
    t3Db.close();
  });

  it("skips threads with pending approval requests or active runs", () => {
    const t3Db = new DatabaseSync(":memory:");
    createT3Schema(t3Db);
    seedCopilotThread(t3Db, { threadId: "t-pending", completedAt, usedTokens: 250_000 });
    t3Db
      .prepare(
        `INSERT INTO orchestration_v2_projection_runtime_requests
         (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at, resolved_at, payload_json)
         VALUES ('req-1', 't-pending', 'node-1', NULL, 'approval', 'pending', ?, NULL, '{}')`,
      )
      .run(completedAt);

    const res = evaluateThreads({
      t3Db,
      copilotDb: null,
      copilotInstances: instances,
      state: { version: 1, threads: {} },
      config: DEFAULT_CONFIG,
      nowMs: completedMs + 250_000,
    });

    assert.equal(res[0].eligible, false);
    assert.equal(res[0].reason, "pending_work_or_approval");
    t3Db.close();
  });
});

describe("runSweep end-to-end with mocked CLI", () => {
  it("dispatches /compact once, persists state, and skips on subsequent sweep", async () => {
    const dir = makeTempDir();
    const t3Home = path.join(dir, ".t3");
    const userdata = path.join(t3Home, "userdata");
    fs.mkdirSync(userdata, { recursive: true });

    fs.writeFileSync(
      path.join(userdata, "settings.json"),
      JSON.stringify({
        providerInstances: {
          "github-copilot": {
            driver: "acpRegistry",
            enabled: true,
            config: { source: "local", agentId: "github-copilot-cli", commandPath: "copilot" },
          },
        },
      }),
    );

    const t3Db = new DatabaseSync(path.join(userdata, "statev2.sqlite"));
    createT3Schema(t3Db);
    const completedAt = "2026-11-23T02:00:00.000Z";
    seedCopilotThread(t3Db, { threadId: "mcp:abc-123", runId: "run-9", completedAt, usedTokens: 400_000 });
    t3Db.close();

    const calls = [];
    const fakeExec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "Sent.", stderr: "" };
    };

    const nowMs = Date.parse(completedAt) + 250_000;
    const statePath = path.join(userdata, "watcher-state.json");
    const silentLogger = { log() {}, error() {} };

    const first = await runSweep({
      t3Home,
      copilotHome: path.join(dir, ".copilot"),
      t3Cli: "/usr/local/bin/t3",
      statePath,
      config: DEFAULT_CONFIG,
      nowMs,
      logger: silentLogger,
      execFileFn: fakeExec,
    });

    assert.equal(first.dispatched.length, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["thread", "send", "--base-dir", t3Home, "mcp:abc-123", "/compact"]);

    const saved = loadState(statePath);
    assert.equal(saved.threads["mcp:abc-123"].lastCompactedRunId, "run-9");

    // Second sweep for same run must skip
    const second = await runSweep({
      t3Home,
      copilotHome: path.join(dir, ".copilot"),
      t3Cli: "/usr/local/bin/t3",
      statePath,
      config: DEFAULT_CONFIG,
      nowMs: nowMs + 15_000,
      logger: silentLogger,
      execFileFn: fakeExec,
    });

    assert.equal(second.dispatched.length, 0);
    assert.equal(calls.length, 1);
  });

  it("persists and reloads state atomically", () => {
    const dir = makeTempDir();
    const statePath = path.join(dir, "state.json");
    saveState(statePath, { version: 1, threads: { t1: { lastCompactedRunId: "r1", compactedAt: "2026-11-23T00:00:00.000Z" } } });
    const loaded = loadState(statePath);
    assert.equal(loaded.threads.t1.lastCompactedRunId, "r1");
  });
});
