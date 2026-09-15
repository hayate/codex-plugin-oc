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

// The logical (/var/...) and physical (/private/var/...) spellings of the
// temp dir, when they differ (macOS). A scope is registered in one spelling
// (mkdtempSync returns the logical form), but the process table may show a
// path in the other: the kernel resolves /var to /private/var at exec time,
// so a spawned process's cwd - and any path derived from it - comes back
// physical. Matching must therefore normalize BOTH sides, or a scoped kill
// silently misses the process it is there to reap.
const TEMP_PREFIX_PAIRS = (() => {
  const logical = os.tmpdir();
  let physical;
  try {
    physical = fs.realpathSync.native(logical);
  } catch {
    physical = null;
  }
  return physical && physical !== logical ? [[logical, physical]] : [];
})();

// Every spelling a given path may appear under in the process table.
function pathForms(p) {
  if (typeof p !== "string" || p.length === 0) {
    return [];
  }
  const forms = new Set([p]);
  for (const [logical, physical] of TEMP_PREFIX_PAIRS) {
    if (p.startsWith(logical)) {
      forms.add(physical + p.slice(logical.length));
    } else if (p.startsWith(physical)) {
      forms.add(logical + p.slice(physical.length));
    }
  }
  return [...forms];
}

// All spellings of the given scopes: each registered dir, its logical and
// physical temp-dir form, and its resolved form (a scope may itself be a
// symlink, or may already have been removed by the time the reaper runs).
function scopePrefixes(scopes) {
  const prefixes = new Set();
  for (const scope of scopes) {
    for (const form of pathForms(scope)) {
      prefixes.add(form);
      try {
        prefixes.add(fs.realpathSync.native(form));
      } catch {
        // Gone or unresolvable: the raw spelling is all we have.
      }
    }
  }
  return [...prefixes];
}

function underAnyScope(p, prefixes) {
  if (typeof p !== "string") {
    return false;
  }
  return pathForms(p).some((form) =>
    prefixes.some((prefix) => form === prefix || form.startsWith(prefix + path.sep))
  );
}

// Strict per-run classifier: a process is ours only if it can be tied to one
// of the scopes this file registered (its temp dirs). Unlike
// classifyCommand, which claims every suite-prefixed process on the machine
// and therefore crosses file boundaries under parallel `node --test`, this
// never claims a process it cannot prove belongs to this run.
//
// Rules:
//   - broker: the command carries app-server-broker.mjs AND its --cwd is
//     under a scope.
//   - app-server: "app-server" is a STANDALONE argument (not a substring of
//     a flag value) AND the codex binary - the argument just before it - is
//     under a scope. The binary, not the prompt text, is what ties the
//     process to this run: a real user's `codex app-server` has its binary
//     on the production PATH, never under a suite temp dir.
export function classifyInScope(command, scopes) {
  if (!command || !Array.isArray(scopes) || scopes.length === 0) {
    return "out-of-scope";
  }
  const prefixes = scopePrefixes(scopes);
  if (command.includes("app-server-broker.mjs")) {
    const cwd = flagValue(command, "--cwd");
    return cwd && underAnyScope(cwd, prefixes) ? "broker" : "out-of-scope";
  }
  const tokens = command.split(/\s+/);
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i] === "app-server" && path.basename(tokens[i - 1]) === "codex") {
      return underAnyScope(tokens[i - 1], prefixes) ? "app-server" : "out-of-scope";
    }
  }
  return "out-of-scope";
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

function listProcessGroups() {
  if (process.platform === "win32") {
    return [];
  }
  const result = spawnSync("ps", ["-ax", "-o", "pid=,pgid="], { encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  // The pid column is right-justified to the width of the largest pid, so a
  // 4-digit pid carries a leading space. Anchor on the leading digits
  // instead of splitting on the first space.
  return result.stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)/);
      return match ? { pid: Number.parseInt(match[1], 10), pgid: Number.parseInt(match[2], 10) } : null;
    })
    .filter((entry) => entry !== null);
}

function killProcessGroup(pid) {
  // Resolve the pid's group, then signal that group. The target is verified
  // alive immediately before the signal: if the pid exited (and its pgid was
  // since recycled to a stranger) in the gap, we fall back to the single
  // pid instead of blasting an unrelated process group.
  const table = listProcessGroups();
  const entry = table.find(({ pid: candidate }) => candidate === pid);
  if (!entry || entry.pgid === 0) {
    return false;
  }
  if (!pidAlive(pid)) {
    return false;
  }
  try {
    process.kill(-entry.pgid, "SIGTERM");
  } catch {
    return false;
  }
  return true;
}

// Kill the detached brokers (and their app-server children) that are scoped
// to this file's temp dirs. Returns the number of broker processes signalled.
//
// Two ownership rules make this safe under parallel `node --test` (one worker
// per file, files concurrent):
//   - only processes classifyInScope() can prove belong to one of this
//     file's registered temp dirs are signalled, so another file's live
//     broker is never touched;
//   - the target is always the pid observed in the process table, never a
//     pidfile value, so a recycled pid (kernel reused it for an unrelated
//     process) is never signalled.
//
// The broker is spawned detached:true, so it leads its own process group and
// its codex app-server child is in that group. Signalling the whole group
// with SIGTERM takes down both in one step and mirrors what the cancel test
// already does for its own detached sleeper: a signal to the broker alone
// leaves the child orphaned when the broker's shutdown handler cannot reach
// it (e.g. the child keeps its own event loop alive). SIGTERM is the
// broker's own clean-shutdown signal (app-server-broker.mjs registers a
// handler that closes the codex app-server child, removes the socket and
// pidfile, and exits).
export async function killTestBrokers({ scopes = [], timeoutMs = 2000 } = {}) {
  const processes = listProcessCommandLines();
  let signalled = 0;

  const brokers = processes.filter(({ command }) => classifyInScope(command, scopes) === "broker");
  const appServers = processes.filter(({ command }) => classifyInScope(command, scopes) === "app-server");
  const killedBrokerPids = new Set();

  for (const { pid, command } of brokers) {
    // NEVER target a pidfile value: if the broker exited and the kernel
    // recycled its pid, the pidfile points at an unrelated process.
    const groupSignalled = killProcessGroup(pid);
    if (!groupSignalled) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await waitForExit(pid, timeoutMs);
    killedBrokerPids.add(pid);
    signalled += 1;

    // Reap any app-server child that the group signal did not reach (e.g. it
    // was spawned by a broker that had already exited before we signalled).
    for (const { pid: childPid } of appServers) {
      if (childPid !== pid && pidAlive(childPid)) {
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
    const pidFile = flagValue(command, "--pid-file");
    if (pidFile) {
      const sessionDir = path.dirname(pidFile);
      if (underTmpdir(sessionDir) && path.basename(sessionDir).startsWith("cxc-")) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  }

  // Any in-scope app-server whose broker was already gone at list time (so it
  // never appeared in the brokers loop) is still this file's leak.
  for (const { pid: childPid } of appServers) {
    if (!killedBrokerPids.has(childPid) && pidAlive(childPid)) {
      try {
        process.kill(childPid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await waitForExit(childPid, timeoutMs);
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
