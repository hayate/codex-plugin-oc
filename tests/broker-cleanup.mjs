import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Reap the detached broker + codex app-server children that the runtime tests
// leave behind. A broker is spawned detached+unref'd so it can outlive each
// short-lived companion process; nothing reaps it when a test ends, so the
// suite accumulates one broker + app-server pair per broker-using test.
//
// Ownership is proven by the suite's own repo prefix, not by "cwd is in
// tmpdir": a user can legitimately run a production broker from a /tmp
// workspace, and killing it would be a footgun. Every repo the tests create
// uses makeTempDir()'s codex-plugin-test- prefix, so a broker whose --cwd
// carries that path (or an app-server whose command line carries it, for the
// fake codex binary) is unambiguously owned by this suite. SIGTERM is the
// broker's own clean-shutdown signal (app-server-broker.mjs registers a
// handler that closes the codex app-server child, removes the socket and
// pidfile, and exits).
//
// Path prefixes must match both the logical and the physical form of the
// temp dir. On macOS os.tmpdir() is /var/... (logical) but process.cwd() -
// which the broker echoes as --cwd after the kernel resolves it - is
// /private/var/... (physical).

const TMPDIR_PREFIXES = [os.tmpdir(), fs.realpathSync.native(os.tmpdir())].filter(
  (dir, index, all) => all.indexOf(dir) === index
);

function underTmpdir(p) {
  return TMPDIR_PREFIXES.some((prefix) => p.startsWith(prefix + path.sep));
}

// True if the path (or command line) carries a suite-owned repo: a
// codex-plugin-test-* directory under the temp dir. "Contains" rather than
// "starts with" because an app-server command line is `node <tmpdir>/.../codex
// app-server`, not the bare path. Both the logical and physical temp-dir
// prefixes are checked (see TMPDIR_PREFIXES).
function containsSuiteRepoPath(p) {
  if (typeof p !== "string") {
    return false;
  }
  return TMPDIR_PREFIXES.some((prefix) => p.includes(`${prefix}${path.sep}codex-plugin-test-`));
}

function listProcessCommandLines() {
  if (process.platform === "win32") {
    // ps(1) is not available; the leak is then not reaped. The suite still
    // passes - the broker is unref'd - it just accumulates, as it did before
    // this helper existed.
    return [];
  }
  const result = spawnSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  // The pid column is right-justified to the width of the largest pid, so a
  // 4-digit pid carries a leading space. Splitting on the first space would
  // read that padding as the delimiter and parse the pid as NaN, silently
  // dropping exactly the processes we need. Anchor on the leading digits
  // instead.
  return result.stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      return match ? { pid: Number.parseInt(match[1], 10), command: match[2].trim() } : null;
    })
    .filter((entry) => entry !== null);
}

function flagValue(command, flag) {
  const match = command.match(new RegExp(`${flag}(?:=|\\s+)(\\S+)`));
  return match ? match[1] : null;
}

// Pure: classify a process command line. Exported for direct unit testing
// without spawning processes. "broker"/"app-server" are the suite-owned kinds
// this helper may kill; "production-broker" must never be touched.
export function classifyCommand(command) {
  if (!command) {
    return "none";
  }
  if (command.includes("app-server-broker.mjs")) {
    const cwd = flagValue(command, "--cwd") ?? "";
    return containsSuiteRepoPath(cwd) ? "broker" : "production-broker";
  }
  if (/app-server\b/.test(command) && containsSuiteRepoPath(command)) {
    return "app-server";
  }
  return "none";
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function waitForExit(pid, timeoutMs = 2000, intervalMs = 25) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!pidAlive(pid) || Date.now() - start >= timeoutMs) {
        resolve(!pidAlive(pid));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function readPidFile(pidFile) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

// Kill the test brokers (and their app-server children) whose --cwd is under
// the suite's temp repos. Returns the number of broker processes signalled.
//
// The broker is spawned detached:true, so it leads its own process group and
// its codex app-server child is in that group. Signalling the whole group
// (negative pid) with SIGTERM takes down both in one step and mirrors what the
// cancel test already does for its own detached sleeper: a signal to the
// broker alone leaves the child orphaned when the broker's shutdown handler
// cannot reach it (e.g. the child keeps its own event loop alive).
export async function killTestBrokers({ timeoutMs = 2000 } = {}) {
  const processes = listProcessCommandLines();
  let signalled = 0;

  const brokers = processes.filter(({ command }) => classifyCommand(command) === "broker");
  const appServers = processes.filter(({ command }) => classifyCommand(command) === "app-server");

  for (const { pid, command } of brokers) {
    const pidFile = flagValue(command, "--pid-file");
    const recorded = pidFile ? readPidFile(pidFile) : null;
    const target = Number.isInteger(recorded) && pidAlive(recorded) ? recorded : pid;

    // Signal the process group first (broker + its app-server child); fall
    // back to the broker alone if the group kill is not permitted.
    try {
      process.kill(-target, "SIGTERM");
    } catch {
      try {
        process.kill(target, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await waitForExit(target, timeoutMs);
    signalled += 1;

    // Reap any app-server child that the group signal did not reach (e.g. it
    // was spawned by a broker that had already exited before we signalled).
    for (const { pid: childPid } of appServers) {
      if (childPid !== target && pidAlive(childPid)) {
        try {
          process.kill(childPid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    }
    await Promise.all(appServers.map(({ pid: childPid }) => waitForExit(childPid, timeoutMs)));

    // Remove the broker's session dir (socket, pidfile, log) when it is one
    // of this suite's cxc-* temp dirs.
    if (pidFile) {
      const sessionDir = path.dirname(pidFile);
      if (underTmpdir(sessionDir) && path.basename(sessionDir).startsWith("cxc-")) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  }

  return signalled;
}

// Remove cxc-* session dirs under the temp dir whose recorded broker is dead.
// The broker's own shutdown handler removes its session dir, but the log
// file it holds open keeps the dir non-empty and its rmdirSync fails
// silently - so a cleanly-exited broker can still leave the dir behind.
//
// Two guards make this safe for production brokers, whose sessions also live
// in cxc-* dirs under tmpdir:
//   - the recorded pid must be dead; a recycled pid (alive for an unrelated
//     process) is kept, never removed;
//   - the dir must be at least a few minutes old, so a production broker
//     that just exited (or is mid-shutdown) is never raced.
export function sweepStaleBrokerSessionDirs({ roots = TMPDIR_PREFIXES, minAgeMs = 3 * 60 * 1000 } = {}) {
  let removed = 0;
  const now = Date.now();
  for (const prefix of roots) {
    let entries;
    try {
      entries = fs.readdirSync(prefix, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("cxc-")) {
        continue;
      }
      const sessionDir = path.join(prefix, entry.name);
      let stat;
      try {
        stat = fs.statSync(sessionDir);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs < minAgeMs) {
        continue;
      }
      const pid = readPidFile(path.join(sessionDir, "broker.pid"));
      if (pid !== null && !pidAlive(pid)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return removed;
}
