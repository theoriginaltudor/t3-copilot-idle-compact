import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { main as runCli } from "../src/cli.mjs";
import {
  acquireSingleInstanceLock,
  computeLockKey,
  resolveCanonicalPath,
  resolveLockEndpoint,
} from "../src/lock.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3-compact-lock-test-"));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe("single-instance lock", () => {
  it("acquires a listening net.Server, returns null on second acquire, and re-acquires after close()", async () => {
    const dir = makeTempDir();
    const t3Home = path.join(dir, ".t3");
    fs.mkdirSync(t3Home, { recursive: true });

    const first = await acquireSingleInstanceLock(t3Home);
    assert.ok(first instanceof net.Server);
    assert.equal(first.listening, true);

    try {
      const second = await acquireSingleInstanceLock(t3Home);
      assert.equal(second, null);
    } finally {
      await closeServer(first);
    }

    const third = await acquireSingleInstanceLock(t3Home);
    assert.ok(third instanceof net.Server);
    assert.equal(third.listening, true);
    await closeServer(third);
  });

  it("allows separate locks for different T3 home directories", async () => {
    const dir = makeTempDir();
    const homeA = path.join(dir, "home-a");
    const homeB = path.join(dir, "home-b");
    fs.mkdirSync(homeA, { recursive: true });
    fs.mkdirSync(homeB, { recursive: true });

    const lockA = await acquireSingleInstanceLock(homeA);
    const lockB = await acquireSingleInstanceLock(homeB);
    try {
      assert.ok(lockA instanceof net.Server);
      assert.ok(lockB instanceof net.Server);
    } finally {
      if (lockA) await closeServer(lockA);
      if (lockB) await closeServer(lockB);
    }
  });

  it("resolves symlinks/junctions and missing children through the nearest existing parent", async () => {
    const dir = makeTempDir();
    const realHome = path.join(dir, "real-home");
    const linkHome = path.join(dir, "link-home");
    fs.mkdirSync(realHome, { recursive: true });
    fs.symlinkSync(realHome, linkHome, process.platform === "win32" ? "junction" : "dir");

    assert.equal(computeLockKey(realHome), computeLockKey(linkHome));
    assert.equal(
      resolveCanonicalPath(path.join(linkHome, "missing", "child")),
      resolveCanonicalPath(path.join(realHome, "missing", "child")),
    );
    assert.equal(
      computeLockKey(path.join(linkHome, "missing", "child")),
      computeLockKey(path.join(realHome, "missing", "child")),
    );

    const lock = await acquireSingleInstanceLock(realHome);
    assert.ok(lock instanceof net.Server);
    try {
      const dupViaLink = await acquireSingleInstanceLock(linkHome);
      assert.equal(dupViaLink, null);
    } finally {
      await closeServer(lock);
    }
  });

  it("formats platform endpoints and handles case sensitivity per platform", () => {
    const dir = makeTempDir();
    const upperPath = path.join(dir, "T3Home");
    const lowerPath = path.join(dir, "t3home");

    const winUpper = resolveLockEndpoint(upperPath, "win32");
    const winLower = resolveLockEndpoint(lowerPath, "win32");
    assert.match(winUpper.endpoint, /^\\\\\.\\pipe\\t3-copilot-idle-compact-[0-9a-f]{16}$/);
    assert.equal(winUpper.key, winLower.key);
    assert.equal(winUpper.isSocketFile, false);

    const macUpper = resolveLockEndpoint(upperPath, "darwin");
    const macLower = resolveLockEndpoint(lowerPath, "darwin");
    assert.match(macUpper.endpoint, /^\/tmp\/t3-copilot-idle-compact-[0-9a-f]{16}\.sock$/);
    assert.equal(macUpper.key, macLower.key);
    assert.equal(macUpper.isSocketFile, true);

    const linuxUpper = resolveLockEndpoint(upperPath, "linux");
    const linuxLower = resolveLockEndpoint(lowerPath, "linux");
    assert.match(linuxUpper.endpoint, /^\0t3-copilot-idle-compact-[0-9a-f]{16}$/);
    assert.notEqual(linuxUpper.key, linuxLower.key);
    assert.equal(linuxUpper.isSocketFile, false);
  });

  if (process.platform !== "win32" && process.platform !== "linux") {
    it("recovers from a stale socket file left behind after a crash", async () => {
      const dir = makeTempDir();
      const t3Home = path.join(dir, "crashed-home");
      fs.mkdirSync(t3Home, { recursive: true });
      const { endpoint } = resolveLockEndpoint(t3Home);

      // Spawn a child that binds the socket and gets SIGKILLed so the .sock file stays behind
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const net = require("node:net"); const s = net.createServer(); s.listen(${JSON.stringify(endpoint)}, () => console.log("READY"));`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("READY")) resolve();
        });
      });

      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      assert.equal(fs.existsSync(endpoint), true);

      const lock = await acquireSingleInstanceLock(t3Home);
      assert.ok(lock instanceof net.Server);
      assert.equal(lock.listening, true);
      await closeServer(lock);
    });
  }

  it("cli.mjs acquires the lock in loop mode only, not in --status or --once", async () => {
    const dir = makeTempDir();
    const t3Home = path.join(dir, ".t3");
    fs.mkdirSync(t3Home, { recursive: true });

    const lock = await acquireSingleInstanceLock(t3Home);
    assert.ok(lock instanceof net.Server);

    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runCli(["--t3-home", t3Home, "--status"]);
      assert.ok(logs.some((line) => line.includes("No active GitHub Copilot CLI threads found.")));
      assert.equal(logs.some((line) => line.includes("another watcher is already running")), false);

      logs.length = 0;
      await runCli(["--t3-home", t3Home, "--once"]);
      assert.equal(logs.some((line) => line.includes("another watcher is already running")), false);

      logs.length = 0;
      await runCli(["--t3-home", t3Home]);
      assert.ok(logs.some((line) => line.includes(`another watcher is already running for ${t3Home}; exiting`)));
    } finally {
      console.log = origLog;
      await closeServer(lock);
    }
  });
});
