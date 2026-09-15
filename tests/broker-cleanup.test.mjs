import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, registeredTempDirsList } from "./helpers.mjs";
import { classifyCommand, classifyInScope, killTestBrokers, sweepStaleBrokerSessionDirs } from "./broker-cleanup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");

function brokerCommand(cwd) {
  return `node ${BROKER} serve --endpoint unix:/x/broker.sock --cwd ${cwd} --pid-file /x/broker.pid`;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!pidAlive(pid) || Date.now() - start > timeoutMs) {
        resolve(!pidAlive(pid));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

function testAppServerLeftovers(scopes) {
  const ps = spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  return ps.stdout.split("\n").filter((line) => classifyInScope(line, scopes) === "app-server");
}

test("classifyCommand only claims brokers and app-servers under the suite's repo prefix", () => {
  const suiteCwd = path.join(os.tmpdir(), "codex-plugin-test-abc");
  assert.equal(classifyCommand(brokerCommand(suiteCwd)), "broker");
  assert.equal(classifyCommand(`node ${os.tmpdir()}/codex-plugin-test-abc/codex app-server`), "app-server");

  // The safety case: a real user's production broker run from a plain /tmp
  // workspace (no suite prefix) must never be classified as ours.
  assert.equal(classifyCommand(brokerCommand(path.join(os.tmpdir(), "my-scratch"))), "production-broker");
  assert.equal(classifyCommand(brokerCommand("/Users/andrea/srv/kabin-api")), "production-broker");
  assert.equal(classifyCommand(`node ${path.join(os.homedir(), ".local/bin/codex")} app-server`), "none");
  assert.equal(classifyCommand("node scripts/install.mjs"), "none");
  assert.equal(classifyCommand(null), "none");
});

test("killTestBrokers stops a live broker spawned for a suite cwd and reaps its app-server child", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const env = buildEnv(binDir);
  const broker = spawn(
    process.execPath,
    [BROKER, "serve", "--endpoint", `unix:${path.join(repo, "broker.sock")}`, "--cwd", repo, "--pid-file", path.join(repo, "broker.pid")],
    { cwd: repo, env, detached: true, stdio: "ignore" }
  );
  broker.unref();

  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(repo, "broker.pid")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(path.join(repo, "broker.pid")), "the broker wrote its pid file");

  const signalled = await killTestBrokers({ scopes: [repo] });
  assert.ok(signalled >= 1, "at least one suite broker was signalled");
  assert.equal(await waitForExit(broker.pid), true, "the broker process exited");
  assert.equal(testAppServerLeftovers([repo]).length, 0, "no in-scope app-server survives");

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

test("killTestBrokers reaps only its own scope: a concurrent file's live broker survives", async () => {
  // `node --test` runs one worker per file, and files run in parallel: when
  // this file's end-of-file hook reaps, another file's broker may be live.
  // Reaping must be scoped to this file's temp dirs, or it kills the other
  // file's broker (or, worse, signals a pid the kernel has since recycled).
  //
  // The "other file" is simulated with a live node process standing in for
  // that file's live worker: the machine-wide reaper signals it too (RED),
  // the scoped reaper must leave it alone (GREEN).
  const thisRepo = makeTempDir();
  const thisBinDir = makeTempDir();
  installFakeCodex(thisBinDir);

  const otherRepo = makeTempDir();
  const otherBinDir = makeTempDir();
  installFakeCodex(otherBinDir);

  const otherEnv = buildEnv(otherBinDir);
  const ourBroker = spawn(
    process.execPath,
    [BROKER, "serve", "--endpoint", `unix:${path.join(thisRepo, "broker.sock")}`, "--cwd", thisRepo, "--pid-file", path.join(thisRepo, "broker.pid")],
    { cwd: thisRepo, env: buildEnv(thisBinDir), detached: true, stdio: "ignore" }
  );
  ourBroker.unref();

  // Simulate the concurrent test file: its own process, its own scope, its
  // own live broker. It stays up until the test tears it down.
  const otherFile = spawn(
    process.execPath,
    ["-e",
      `import { spawn } from "node:child_process";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `const b = spawn(${JSON.stringify(process.execPath)}, ${JSON.stringify([BROKER, "serve", "--endpoint", `unix:${path.join(otherRepo, "broker.sock")}`, "--cwd", otherRepo, "--pid-file", path.join(otherRepo, "broker.pid")])}, { cwd: ${JSON.stringify(otherRepo)}, env: ${JSON.stringify(otherEnv)}, detached: true, stdio: "ignore" });\n` +
      `b.unref();\n` +
      `writeFileSync(${JSON.stringify(path.join(otherRepo, "other-broker.pid"))}, String(b.pid));\n` +
      `setInterval(() => {}, 1000);\n`
    ],
    { stdio: "ignore" }
  );

  const otherPidFile = path.join(otherRepo, "other-broker.pid");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(otherPidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(otherPidFile), "the simulated other file recorded its broker pid");
  const otherBrokerPid = Number.parseInt(fs.readFileSync(otherPidFile, "utf8").trim(), 10);

  try {
    const signalled = await killTestBrokers({ scopes: [thisRepo] });
    assert.ok(signalled >= 1, "this file's broker was signalled");
    assert.equal(await waitForExit(ourBroker.pid), true, "this file's broker exited");
    assert.equal(pidAlive(otherBrokerPid), true, "the other file's broker survived the scoped reap");
    assert.equal(pidAlive(otherFile.pid), true, "the other file's live worker survived the scoped reap");
  } finally {
    otherFile.kill("SIGTERM");
    // Tear down the other file's broker the same scoped way, so nothing leaks.
    await killTestBrokers({ scopes: [otherRepo] });
    fs.rmSync(thisRepo, { recursive: true, force: true });
    fs.rmSync(otherRepo, { recursive: true, force: true });
    fs.rmSync(thisBinDir, { recursive: true, force: true });
    fs.rmSync(otherBinDir, { recursive: true, force: true });
  }
});

test("killTestBrokers targets the observed pid, never the pidfile value", async () => {
  // A pidfile is only safe to act on while the broker that wrote it is the
  // process holding that pid. If the broker has exited and the kernel reused
  // its pid for an unrelated process, the pidfile is a stale pointer: the
  // kill-path must target the pid observed in the process table, so the
  // recycled pid (here, a live unrelated process) is never signalled.
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  // A live unrelated process standing in for the recycled pid.
  const recycled = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000);`], { stdio: "ignore" });

  // A real in-scope broker, whose pidfile we then corrupt with the recycled
  // pid before reaping: exactly the state a recycled pidfile has.
  const broker = spawn(
    process.execPath,
    [BROKER, "serve", "--endpoint", `unix:${path.join(repo, "broker.sock")}`, "--cwd", repo, "--pid-file", path.join(repo, "broker.pid")],
    { cwd: repo, env: buildEnv(binDir), detached: true, stdio: "ignore" }
  );
  broker.unref();

  const pidFile = path.join(repo, "broker.pid");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(pidFile), "the broker wrote its pid file");
  fs.writeFileSync(pidFile, `${recycled.pid}\n`);

  try {
    const signalled = await killTestBrokers({ scopes: [repo] });
    assert.ok(signalled >= 1, "the observed in-scope broker was signalled");
    assert.equal(await waitForExit(broker.pid), true, "the broker exited");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(pidAlive(recycled.pid), true, "the recycled (unrelated) process was not signalled");
  } finally {
    recycled.kill("SIGTERM");
    await waitForExit(recycled.pid);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("classifyInScope claims in-scope processes only, in both temp-dir spellings", () => {
  // The scoped classifier is the strict per-run rule: a process is ours only
  // if its cwd (broker) or codex binary (app-server) sits under one of the
  // scopes this file registered. Logical /var/... and physical
  // /private/var/... spellings of the same scope must both match.
  const repo = makeTempDir(); // logical spelling; exists, so realpath works
  const physicalRepo = fs.realpathSync.native(repo);
  const codexBinary = path.join(repo, "codex");

  assert.equal(
    classifyInScope(`node ${BROKER} serve --cwd ${repo} --pid-file /x/pid`, [repo]),
    "broker"
  );
  // The kernel spells the broker's --cwd in physical form.
  assert.equal(
    classifyInScope(`node ${BROKER} serve --cwd ${physicalRepo} --pid-file /x/pid`, [repo]),
    "broker"
  );
  // A sibling scope must not match: same prefix, different dir.
  assert.equal(
    classifyInScope(`node ${BROKER} serve --cwd ${makeTempDir()} --pid-file /x/pid`, [repo]),
    "out-of-scope"
  );

  assert.equal(
    classifyInScope(`node ${codexBinary} app-server`, [repo]),
    "app-server"
  );
  // The physical spelling of the binary must match too.
  assert.equal(
    classifyInScope(`node ${path.join(physicalRepo, "codex")} app-server`, [repo]),
    "app-server"
  );
  // "app-server" must be a standalone argument, not a substring of a flag value.
  assert.equal(
    classifyInScope(`node ${codexBinary} exec --prompt run the app-server now`, [repo]),
    "out-of-scope"
  );
  // The codex binary, not the prompt text, must sit under a scope.
  assert.equal(
    classifyInScope(`node ${path.join(os.homedir(), ".local/bin/codex")} app-server`, [repo]),
    "out-of-scope"
  );
  assert.equal(classifyInScope("node scripts/install.mjs", [repo]), "out-of-scope");
  assert.equal(classifyInScope(null, [repo]), "out-of-scope");
  assert.equal(classifyInScope(`node ${BROKER} serve --cwd ${repo}`, []), "out-of-scope");
});

after(async () => {
  // Never leak the stand-in processes this file created, even on failure.
  await killTestBrokers({ scopes: registeredTempDirsList() });
});

function makeSessionDir(prefix, { ageMs = 0, pid } = {}) {
  const dir = fs.mkdtempSync(path.join(prefix, "cxc-"));
  const pidFile = path.join(dir, "broker.pid");
  if (pid !== undefined) {
    fs.writeFileSync(pidFile, `${pid}\n`);
  }
  fs.writeFileSync(path.join(dir, "broker.log"), "log\n");
  if (ageMs > 0) {
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, mtime, mtime);
  }
  return dir;
}

test("sweepStaleBrokerSessionDirs removes old dirs of dead brokers and keeps everything else", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-sweep-root-"));
  const deadPid = 4194000; // above macOS pid_max, guaranteed dead

  const oldDead = makeSessionDir(root, { ageMs: 10 * 60 * 1000, pid: deadPid });
  const youngDead = makeSessionDir(root, { ageMs: 1000, pid: deadPid });
  const oldAlive = makeSessionDir(root, { ageMs: 10 * 60 * 1000, pid: process.pid });
  const oldNoPidFile = makeSessionDir(root, { ageMs: 10 * 60 * 1000 });
  const notCxcprefix = fs.mkdtempSync(path.join(root, "other-"));
  fs.writeFileSync(path.join(notCxcprefix, "broker.pid"), `${deadPid}\n`);

  const removed = sweepStaleBrokerSessionDirs({ roots: [root] });

  assert.equal(removed, 1, "exactly the old dead-broker dir was removed");
  assert.equal(fs.existsSync(oldDead), false, "old dir of a dead broker removed");
  assert.equal(fs.existsSync(youngDead), true, "recently-created dir kept (age guard)");
  assert.equal(fs.existsSync(oldAlive), true, "dir of an alive (recycled) pid kept");
  assert.equal(fs.existsSync(oldNoPidFile), true, "dir without a pid file kept");
  assert.equal(fs.existsSync(notCxcprefix), true, "non-cxc dir untouched");

  fs.rmSync(root, { recursive: true, force: true });
});
