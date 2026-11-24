import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { acquireSingleInstanceLock } from "./lock.mjs";
import {
  resolveCopilotHome,
  resolveT3Cli,
  resolveT3Home,
  resolveWatcherStatePath,
} from "./paths.mjs";
import { DEFAULT_CONFIG, formatDuration, runSweep } from "./watcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const CACHE_TTL_MS = 300_000; // 5m00s Anthropic ephemeral cache TTL

export function parseArgs(argv, env = process.env) {
  let idleMinExplicit = false;
  let sendTimeoutExplicit = env.T3_COMPACT_SEND_TIMEOUT_MS !== undefined && env.T3_COMPACT_SEND_TIMEOUT_MS !== "";
  let waitExplicit = false;

  const opts = {
    minTokens: parsePositiveInt(env.T3_COMPACT_MIN_TOKENS, DEFAULT_CONFIG.minTokens),
    idleMinSec: parsePositiveInt(env.T3_COMPACT_IDLE_MIN_SEC, DEFAULT_CONFIG.idleMinSec),
    idleMaxSec: parsePositiveInt(env.T3_COMPACT_IDLE_MAX_SEC, DEFAULT_CONFIG.idleMaxSec),
    pollSec: parsePositiveInt(env.T3_COMPACT_POLL_SEC, DEFAULT_CONFIG.pollSec),
    sendTimeoutMs: parsePositiveInt(env.T3_COMPACT_SEND_TIMEOUT_MS, DEFAULT_CONFIG.sendTimeoutMs),
    t3Home: env.T3CODE_HOME || undefined,
    copilotHome: env.COPILOT_HOME || undefined,
    t3Cli: env.T3_CLI || undefined,
    stateFile: env.T3_COMPACT_STATE_FILE || undefined,
    providers: env.T3_COMPACT_PROVIDERS
      ? env.T3_COMPACT_PROVIDERS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    once: false,
    dryRun: false,
    status: false,
    warm: false,
    now: false,
    interactive: false,
    wait: false,
    verbose: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };

    switch (arg) {
      case "--min-tokens":
        opts.minTokens = parseStrictPositiveInt(next(), arg);
        break;
      case "--idle-min":
        opts.idleMinSec = parseStrictPositiveInt(next(), arg);
        idleMinExplicit = true;
        break;
      case "--idle-max":
        opts.idleMaxSec = parseStrictPositiveInt(next(), arg);
        break;
      case "--poll":
        opts.pollSec = parseStrictPositiveInt(next(), arg);
        break;
      case "--send-timeout-ms":
        opts.sendTimeoutMs = parseStrictPositiveInt(next(), arg);
        sendTimeoutExplicit = true;
        break;
      case "--t3-home":
        opts.t3Home = next();
        break;
      case "--copilot-home":
        opts.copilotHome = next();
        break;
      case "--t3-cli":
        opts.t3Cli = next();
        break;
      case "--state-file":
        opts.stateFile = next();
        break;
      case "--providers":
        opts.providers = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--once":
        opts.once = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--status":
        opts.status = true;
        break;
      case "--warm":
        opts.warm = true;
        break;
      case "--now":
        opts.now = true;
        break;
      case "--interactive":
      case "-i":
        opts.interactive = true;
        break;
      case "--yes":
      case "-y":
        opts.interactive = false;
        break;
      case "--wait":
        opts.wait = true;
        waitExplicit = true;
        break;
      case "--no-wait":
        opts.wait = false;
        waitExplicit = true;
        break;
      case "--verbose":
      case "-v":
        opts.verbose = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--version":
        opts.version = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}. Run with --help for usage.`);
    }
  }

  if (opts.warm || opts.now) {
    if (!idleMinExplicit) {
      opts.idleMinSec = 0;
    }
    if (opts.now && !waitExplicit) {
      opts.wait = true;
    }
    if (opts.wait && !sendTimeoutExplicit) {
      opts.sendTimeoutMs = DEFAULT_CONFIG.waitTimeoutMs;
    }
  }

  if (opts.idleMinSec > opts.idleMaxSec) {
    throw new Error(`--idle-min (${opts.idleMinSec}s) cannot be greater than --idle-max (${opts.idleMaxSec}s)`);
  }

  return opts;
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function parseStrictPositiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} expects a non-negative integer, got: ${raw}`);
  }
  return n;
}

function printHelp() {
  console.log(`${pkg.name} v${pkg.version}

Automatically sends /compact to idle GitHub Copilot CLI threads in T3 Code
while their 5-minute prompt cache is still warm.

USAGE
  t3-copilot-idle-compact [options]

OPTIONS
  --min-tokens <n>       Minimum context tokens before compacting (default: ${DEFAULT_CONFIG.minTokens})
  --idle-min <sec>       Minimum seconds idle before compacting (default: ${DEFAULT_CONFIG.idleMinSec})
  --idle-max <sec>       Maximum seconds idle (skip cold cache) (default: ${DEFAULT_CONFIG.idleMaxSec})
  --poll <sec>           Polling interval in seconds (default: ${DEFAULT_CONFIG.pollSec})
  --providers <csv>      Override detected Copilot providerInstanceIds (comma-separated)
  --t3-home <dir>        T3 Code data dir (default: ~/.t3 or $T3CODE_HOME)
  --copilot-home <dir>   Copilot CLI home dir (default: ~/.copilot or $COPILOT_HOME)
  --t3-cli <path>        Path to t3 CLI executable (auto-detected)
  --state-file <path>    Path to persistent dedupe state JSON
  --status               Print current Copilot threads, token counts, and eligibility, then exit
  --warm                 List threads worth compacting right now (>= min-tokens, warm <= idle-max)
  --now                  Compact all warm threads right now (waits for completion so safe to sleep)
  -i, --interactive      With --now, list warm threads and ask [y/N] before compacting
  -y, --yes              Skip interactive confirmation prompt
  --wait / --no-wait     Wait for /compact to finish (default: on for --now, off for daemon)
  --once                 Run a single sweep and exit
  --dry-run              Evaluate and log without sending /compact
  -v, --verbose          Log skipped threads on every sweep
  --version              Print version
  -h, --help             Show this help

ENVIRONMENT VARIABLES
  T3_COMPACT_MIN_TOKENS, T3_COMPACT_IDLE_MIN_SEC, T3_COMPACT_IDLE_MAX_SEC,
  T3_COMPACT_POLL_SEC, T3_COMPACT_PROVIDERS, T3_COMPACT_STATE_FILE,
  T3CODE_HOME, COPILOT_HOME, T3_CLI
`);
}

function printStatusReport(summary, meta) {
  console.log(`t3-copilot-idle-compact v${pkg.version}`);
  console.log(`  T3 home      : ${meta.t3Home}`);
  console.log(`  Copilot home : ${meta.copilotHome}`);
  console.log(`  t3 CLI       : ${meta.t3Cli}`);
  console.log(`  State file   : ${meta.statePath}`);
  console.log(
    `  Rule         : >= ${meta.config.minTokens.toLocaleString("en-US")} tokens, idle ${meta.config.idleMinSec}s..${meta.config.idleMaxSec}s`,
  );
  console.log(
    `  Providers    : ${summary.copilotInstances.size > 0 ? [...summary.copilotInstances].join(", ") : "(none enabled)"}`,
  );
  console.log("");

  if (summary.evaluated.length === 0) {
    console.log("No active GitHub Copilot CLI threads found.");
    return;
  }

  for (const t of summary.evaluated) {
    const tokens = t.usedTokens !== null ? `${t.usedTokens.toLocaleString("en-US")} (${t.tokenSource})` : "unknown";
    const idleDur = formatDuration(t.idleMs);
    const idle = t.idleMs !== null && t.idleSource && t.idleSource !== "none" ? `${idleDur} (${t.idleSource})` : idleDur;
    const badge = t.eligible ? "ELIGIBLE" : `skip:${t.reason}`;
    console.log(`- [${badge}] ${t.title}`);
    console.log(`    id=${t.threadId}  provider=${t.providerInstanceId}  tokens=${tokens}  idle=${idle}`);
  }
}

function printWarmReport(summary, meta, verbose) {
  const eligible = summary.evaluated.filter((t) => t.eligible);
  console.log(
    `Warm threads worth compacting (>= ${meta.config.minTokens.toLocaleString("en-US")} tokens, cache age ${meta.config.idleMinSec}s..${meta.config.idleMaxSec}s):`,
  );

  if (eligible.length === 0) {
    console.log("  None right now.");
  } else {
    for (const t of eligible) {
      const tokens = `${t.usedTokens.toLocaleString("en-US")} (${t.tokenSource})`;
      const age = formatDuration(t.idleMs);
      const remainingMs = Math.max(0, CACHE_TTL_MS - (t.idleMs ?? 0));
      const remaining = formatDuration(remainingMs);
      console.log(`- ${t.title}`);
      console.log(
        `    id=${t.threadId}  tokens=${tokens}  cacheAge=${age} (${t.idleSource})  ~${remaining} left`,
      );
    }
  }

  if (verbose) {
    const skipped = summary.evaluated.filter((t) => !t.eligible);
    if (skipped.length > 0) {
      console.log("\nSkipped:");
      for (const t of skipped) {
        const tokens = t.usedTokens !== null ? `${t.usedTokens.toLocaleString("en-US")} (${t.tokenSource})` : "unknown";
        const idleDur = formatDuration(t.idleMs);
        const idle =
          t.idleMs !== null && t.idleSource && t.idleSource !== "none" ? `${idleDur} (${t.idleSource})` : idleDur;
        console.log(`- [skip:${t.reason}] ${t.title}  (tokens=${tokens}, idle=${idle})`);
      }
    }
  }

  return eligible;
}

async function promptConfirm(question) {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function main(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.version) {
    console.log(pkg.version);
    return;
  }

  const t3Home = resolveT3Home(opts.t3Home);
  const copilotHome = resolveCopilotHome(opts.copilotHome);
  const t3Cli = resolveT3Cli(t3Home, opts.t3Cli);
  const statePath = resolveWatcherStatePath(t3Home, opts.stateFile);

  const config = {
    minTokens: opts.minTokens,
    idleMinSec: opts.idleMinSec,
    idleMaxSec: opts.idleMaxSec,
    pollSec: opts.pollSec,
    sendTimeoutMs: opts.sendTimeoutMs,
  };

  if (opts.status) {
    const summary = await runSweep({
      t3Home,
      copilotHome,
      t3Cli,
      statePath,
      explicitProviders: opts.providers,
      config,
      dryRun: true,
      verbose: false,
      logger: { log() {}, error: console.error },
    });
    printStatusReport(summary, { t3Home, copilotHome, t3Cli, statePath, config });
    return;
  }

  if (opts.warm && !opts.now) {
    const summary = await runSweep({
      t3Home,
      copilotHome,
      t3Cli,
      statePath,
      explicitProviders: opts.providers,
      config,
      dryRun: true,
      verbose: false,
      logger: { log() {}, error: console.error },
    });
    printWarmReport(summary, { t3Home, copilotHome, t3Cli, statePath, config }, opts.verbose);
    return;
  }

  const inFlight = new Set();

  if (opts.now) {
    const preview = await runSweep({
      t3Home,
      copilotHome,
      t3Cli,
      statePath,
      explicitProviders: opts.providers,
      config,
      dryRun: true,
      verbose: false,
      logger: { log() {}, error: console.error },
    });
    const eligible = printWarmReport(preview, { t3Home, copilotHome, t3Cli, statePath, config }, opts.verbose);
    if (eligible.length === 0 || opts.dryRun) {
      return;
    }

    if (opts.interactive) {
      const ok = await promptConfirm(`\nCompact ${eligible.length} thread(s) now? [y/N] `);
      if (!ok) {
        console.log("Cancelled.");
        return;
      }
    }

    console.log(
      opts.wait
        ? `\nCompacting ${eligible.length} thread(s) and waiting for completion...`
        : `\nDispatching /compact to ${eligible.length} thread(s)...`,
    );

    const res = await runSweep({
      t3Home,
      copilotHome,
      t3Cli,
      statePath,
      explicitProviders: opts.providers,
      config,
      dryRun: false,
      wait: opts.wait,
      inFlight,
      verbose: false,
    });

    if (res.errors.length > 0) {
      process.exitCode = 1;
      console.error(`Completed with ${res.dispatched.length} compacted and ${res.errors.length} error(s).`);
    } else if (opts.wait && res.dispatched.length > 0) {
      console.log(`Done (${res.dispatched.length} compacted). Safe to sleep.`);
    }
    return;
  }

  if (opts.once) {
    await runSweep({
      t3Home,
      copilotHome,
      t3Cli,
      statePath,
      explicitProviders: opts.providers,
      config,
      dryRun: opts.dryRun,
      wait: opts.wait,
      inFlight,
      verbose: opts.verbose,
    });
    return;
  }

  const lockServer = await acquireSingleInstanceLock(t3Home);
  if (!lockServer) {
    console.log(`[${new Date().toISOString()}] another watcher is already running for ${t3Home}; exiting`);
    return;
  }

  console.log(
    `[${new Date().toISOString()}] starting ${pkg.name} v${pkg.version} (minTokens=${config.minTokens}, idle=${config.idleMinSec}s..${config.idleMaxSec}s, poll=${config.pollSec}s${opts.dryRun ? ", DRY-RUN" : ""})`,
  );

  let stopped = false;
  let timer = null;

  const stop = (signal) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    lockServer.close();
    console.log(`[${new Date().toISOString()}] received ${signal}, shutting down`);
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  const tick = async () => {
    if (stopped) return;
    try {
      await runSweep({
        t3Home,
        copilotHome,
        t3Cli,
        statePath,
        explicitProviders: opts.providers,
        config,
        dryRun: opts.dryRun,
        inFlight,
        verbose: opts.verbose,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!stopped) {
      timer = setTimeout(tick, config.pollSec * 1000);
    }
  };

  await tick();
}
