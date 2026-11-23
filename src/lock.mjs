import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * Resolve symlinks and junctions through the nearest existing parent so a
 * non-existent target path still canonicalizes consistently.
 */
export function resolveCanonicalPath(targetPath) {
  let current = path.resolve(targetPath);
  const missingSegments = [];

  while (true) {
    try {
      const real = fs.realpathSync.native(current);
      return missingSegments.length > 0 ? path.join(real, ...missingSegments.reverse()) : real;
    } catch (err) {
      if (err && err.code !== "ENOENT" && err.code !== "ENOTDIR") {
        return missingSegments.length > 0 ? path.join(current, ...missingSegments.reverse()) : current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return missingSegments.length > 0 ? path.join(current, ...missingSegments.reverse()) : current;
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Compute the 16-hex-character SHA-256 key for a T3 home path.
 * Lowercases on non-Linux platforms (macOS / Windows).
 */
export function computeLockKey(t3Home, platform = process.platform) {
  const canonical = resolveCanonicalPath(t3Home);
  const normalized = platform === "linux" ? canonical : canonical.toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Resolve the platform-specific IPC endpoint for the single-instance lock.
 */
export function resolveLockEndpoint(t3Home, platform = process.platform) {
  const key = computeLockKey(t3Home, platform);

  if (platform === "win32") {
    return {
      key,
      endpoint: `\\\\.\\pipe\\t3-copilot-idle-compact-${key}`,
      isSocketFile: false,
    };
  }

  if (platform === "linux") {
    return {
      key,
      endpoint: `\0t3-copilot-idle-compact-${key}`,
      isSocketFile: false,
    };
  }

  return {
    key,
    endpoint: `/tmp/t3-copilot-idle-compact-${key}.sock`,
    isSocketFile: true,
  };
}

function tryListen(endpoint) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.end();
    });

    const onError = (err) => {
      server.removeListener("listening", onListening);
      reject(err);
    };

    const onListening = () => {
      server.removeListener("error", onError);
      server.unref();
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function isSocketAlive(socketPath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };

    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(true), timeoutMs);
    timer.unref();

    socket.once("connect", () => finish(true));
    socket.once("error", (err) => {
      if (err && (err.code === "ECONNREFUSED" || err.code === "ENOENT")) {
        finish(false);
      } else {
        finish(true);
      }
    });
  });
}

/**
 * Acquire a single-instance lock for the given T3 home directory.
 * Returns a listening, unref'd `net.Server`, or `null` if another watcher holds the lock.
 */
export async function acquireSingleInstanceLock(t3Home, { platform = process.platform } = {}) {
  const { endpoint, isSocketFile } = resolveLockEndpoint(t3Home, platform);

  try {
    return await tryListen(endpoint);
  } catch (err) {
    if (!err || err.code !== "EADDRINUSE") {
      throw err;
    }

    if (!isSocketFile) {
      return null;
    }

    if (await isSocketAlive(endpoint)) {
      return null;
    }

    try {
      fs.unlinkSync(endpoint);
    } catch (unlinkErr) {
      if (!unlinkErr || unlinkErr.code !== "ENOENT") {
        throw unlinkErr;
      }
    }

    try {
      return await tryListen(endpoint);
    } catch (retryErr) {
      if (retryErr && retryErr.code === "EADDRINUSE") {
        return null;
      }
      throw retryErr;
    }
  }
}
