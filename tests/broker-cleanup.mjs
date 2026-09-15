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

// Canonical spellings of a path for scope matching.
//
// The process table may show a path in a different spelling than the scope:
// the kernel resolves /var to /private/var at exec time, so a spawned
// process's cwd - and any path derived from it - comes back physical while
// the scope (mkdtempSync's return) is logical. Three spellings are kept:
//   - the raw form: always present;
//   - the lexical form (path.resolve): normalizes `..` and `.` components,
//     so a non-canonical spelling cannot escape the scope via traversal;
//   - the physical form (realpathSync.native): resolves symlinks and the
//     /var -> /private/var alias; only defined while the path still exists.
function canonicalForms(p) {
  if (typeof p !== "string" || p.length === 0) {
    return [];
  }
  const forms = new Set([p, path.resolve(p)]);
  try {
    forms.add(fs.realpathSync.native(p));
  } catch {
    // Gone or unresolvable: the raw and lexical forms are all we have.
  }
  return [...forms];
}

// Every canonical spelling of the given scopes (each registered dir, its
// resolved form, its lexical form). A scope that has already been removed
// still contributes its raw and lexical spellings, so a process table entry
// captured earlier still matches.
function scopePrefixes(scopes) {
  const prefixes = new Set();
  for (const scope of scopes) {
    for (const form of canonicalForms(scope)) {
      prefixes.add(form);
    }
  }
  return [...prefixes];
}

// True if the path is the scope itself or under it, comparing canonical
// spellings on BOTH sides - so the /var vs /private/var alias and `..`
// traversal cannot cross the boundary. A non-canonical candidate (carries
// `..` or `.` components, i.e. it does not equal its own path.resolve) is
// judged ONLY on its resolved forms: comparing its raw string would let
// <scope>/../sibling slip under the prefix textually.
function underAnyScope(p, prefixes) {
  if (typeof p !== "string") {
    return false;
  }
  const lexical = path.resolve(p);
  const forms = new Set(p === lexical ? [p] : [lexical]);
  try {
    forms.add(fs.realpathSync.native(p));
  } catch {
    // Gone or unresolvable: the lexical form is all we have.
  }
  return [...forms].some((form) =>
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
//   - app-server: "app-server" is the FINAL argument, the token before it is
//     the codex binary (basename "codex"), and that binary is under a
//     scope. The final-token rule is what the real spawn looks like
//     (`spawn("codex", ["app-server"])` - nothing after it) and it is what
//     keeps a prompt like `codex exec explain <scope>/codex app-server` from
//     being misread as an owned app-server: prompt text that merely CONTAINS
//     the sequence is not the invocation.
export function classifyInScope(command, scopes) {
  if (!command || !Array.isArray(scopes) || scopes.length === 0) {
    return "out-of-scope";
  }
  const prefixes = scopePrefixes(scopes);
  if (command.includes("app-server-broker.mjs")) {
    const cwd = flagValue(command, "--cwd");
    return cwd && underAnyScope(cwd, prefixes) ? "broker" : "out-of-scope";
  }
  const tokens = command.trim().split(/\s+/);
  if (tokens.length >= 2 && tokens[tokens.length - 1] === "app-server" && path.basename(tokens[tokens.length - 2]) === "codex") {
    return underAnyScope(tokens[tokens.length - 2], prefixes) ? "app-server" : "out-of-scope";
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
  // One snapshot carries pid, pgid AND the full command line: the group
  // lookup and the identity re-check below must read the SAME table, or the
  // guard proves nothing about the process that actually gets signalled.
  const result = spawnSync("ps", ["-ax", "-o", "pid=,pgid=,command="], { encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  // The pid column is right-justified to the width of the largest pid, so a
  // 4-digit pid carries a leading space. Anchor on the leading digits
  // instead of splitting on the first space.
  return result.stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return match
        ? { pid: Number.parseInt(match[1], 10), pgid: Number.parseInt(match[2], 10), command: match[3].trim() }
        : null;
    })
    .filter((entry) => entry !== null);
}

// True if, in the given table snapshot, the pid still holds a command that
// classifies as the owned kind. pidAlive proves the pid EXISTS; this proves
// it is still OURS. A pid the kernel recycled between the initial listing and
// the signal carries a stranger's command line and fails this check, so the
// signal never reaches the stranger (or its group).
function ownedIn(table, pid, kind, scopes) {
  const entry = table.find(({ pid: candidate }) => candidate === pid);
  return entry !== undefined && classifyInScope(entry.command, scopes) === kind;
}

// Signal the broker's process group (broker + its app-server child in one
// step). One table snapshot serves both the group lookup and the identity
// re-check, so the guard proves something about the exact group signalled.
// Returns false if the pid is no longer owned or the group cannot be
// resolved.
function killProcessGroup(pid, kind, scopes) {
  const table = listProcessGroups();
  const entry = table.find(({ pid: candidate }) => candidate === pid);
  if (!entry || entry.pgid === 0) {
    return false;
  }
  if (!ownedIn(table, pid, kind, scopes)) {
    return false;
  }
  try {
    process.kill(-entry.pgid, "SIGTERM");
  } catch {
    return false;
  }
  return true;
}

// Signal a single pid, but only if a fresh snapshot still shows it holding
// a command that classifies as the owned kind. This is the gate that makes
// the recycled-pid window (observed 0/30 on this box, but real) a no-op
// instead of a kill.
function signalOwned(pid, kind, scopes) {
  const table = listProcessGroups();
  if (!ownedIn(table, pid, kind, scopes)) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
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
  const processes = listProcessGroups();
  let signalled = 0;

  const brokers = processes.filter(({ command }) => classifyInScope(command, scopes) === "broker");
  const appServers = processes.filter(({ command }) => classifyInScope(command, scopes) === "app-server");
  const killedBrokerPids = new Set();

  for (const { pid, command } of brokers) {
    // NEVER target a pidfile value: if the broker exited and the kernel
    // recycled its pid, the pidfile points at an unrelated process. The
    // group signal is identity-gated (ownedIn) on a fresh snapshot, so a
    // recycled pid is a no-op.
    const groupSignalled = killProcessGroup(pid, "broker", scopes);
    if (!groupSignalled) {
      signalOwned(pid, "broker", scopes);
    }
    await waitForExit(pid, timeoutMs);
    killedBrokerPids.add(pid);
    signalled += 1;

    // Reap any app-server child that the group signal did not reach (e.g. it
    // was spawned by a broker that had already exited before we signalled).
    // Each signal is identity-gated, so a recycled child pid is never hit.
    for (const { pid: childPid } of appServers) {
      if (childPid !== pid) {
        signalOwned(childPid, "app-server", scopes);
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
    if (!killedBrokerPids.has(childPid)) {
      signalOwned(childPid, "app-server", scopes);
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
