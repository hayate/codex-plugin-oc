import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { classifyCommand, killTestBrokers, sweepStaleBrokerSessionDirs } from "./broker-cleanup.mjs";

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

function testAppServerLeftovers() {
  const ps = spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  return ps.stdout.split("\n").filter((line) => classifyCommand(line) === "app-server");
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

  const signalled = await killTestBrokers();
  assert.ok(signalled >= 1, "at least one suite broker was signalled");
  assert.equal(await waitForExit(broker.pid), true, "the broker process exited");
  assert.equal(testAppServerLeftovers().length, 0, "no suite app-server survives");

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

after(async () => {
  // Never leak the stand-in processes this file created, even on failure.
  await killTestBrokers();
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
