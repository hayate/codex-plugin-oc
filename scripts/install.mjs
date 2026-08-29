#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const BIN_DIR = path.join(os.homedir(), ".local", "bin");
const BIN_LINK = path.join(BIN_DIR, "codex-companion");

function opencodeDir() {
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
}

const LINK_PAIRS = [
  { target: path.join(ROOT, "commands"), dir: path.join(opencodeDir(), "commands") },
  { target: path.join(ROOT, "agents"), dir: path.join(opencodeDir(), "agents") },
  { target: path.join(ROOT, "plugins", "codex", "skills"), dir: path.join(opencodeDir(), "skills") },
  { target: path.join(ROOT, "plugins", "codex"), dir: path.join(opencodeDir(), "plugins"), only: ["codex-session-env.js"] }
];

function resolveLinkTarget(linkPath) {
  try {
    return fs.realpathSync(linkPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      try {
        return fs.readlinkSync(linkPath);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function linkDir(target, dir, only = null) {
  fs.mkdirSync(dir, { recursive: true });
  const entries = fs.readdirSync(target, { withFileTypes: true }).filter((entry) => only === null || only.includes(entry.name));
  let count = 0;
  for (const entry of entries) {
    const linkPath = path.join(dir, entry.name);
    const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (existing !== undefined) {
      if (existing.isSymbolicLink() && resolveLinkTarget(linkPath) === path.join(target, entry.name)) {
        continue;
      }
      console.warn(`skipping ${linkPath}: exists and is not our symlink`);
      continue;
    }
    if (!fs.existsSync(path.join(target, entry.name))) {
      console.warn(`skipping ${entry.name}: source missing in ${target}`);
      continue;
    }
    fs.symlinkSync(path.join(target, entry.name), linkPath);
    count += 1;
  }
  return count;
}

function unlinkDir(target, dir, only = null) {
  if (!fs.existsSync(dir)) {
    return 0;
  }
  const entries = fs.readdirSync(target, { withFileTypes: true }).filter((entry) => only === null || only.includes(entry.name));
  let count = 0;
  for (const entry of entries) {
    const linkPath = path.join(dir, entry.name);
    let existing;
    try {
      existing = fs.lstatSync(linkPath);
    } catch {
      continue;
    }
    if (existing.isSymbolicLink() && resolveLinkTarget(linkPath) === path.join(target, entry.name)) {
      fs.unlinkSync(linkPath);
      count += 1;
    }
  }
  return count;
}

function install() {
  let count = 0;

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const existing = fs.lstatSync(BIN_LINK, { throwIfNoEntry: false });
  if (existing !== undefined && !(existing.isSymbolicLink() && resolveLinkTarget(BIN_LINK) === COMPANION)) {
    console.error(`${BIN_LINK} exists and is not this plugin's symlink.`);
    console.error(`Move or remove it, then rerun: node ${path.join(ROOT, "scripts", "install.mjs")}`);
    process.exitCode = 1;
    return 0;
  }
  if (existing === undefined) {
    fs.symlinkSync(COMPANION, BIN_LINK);
    count += 1;
    console.log(`linked ${BIN_LINK} -> ${COMPANION}`);
  } else {
    console.log(`${BIN_LINK} already linked`);
  }
  if (!(process.env.PATH ?? "").split(path.delimiter).includes(BIN_DIR)) {
    console.warn(`${BIN_DIR} is not on PATH; the codex-companion commands will not resolve. Add it and restart OpenCode.`);
  }

  for (const { target, dir, only } of LINK_PAIRS) {
    const added = linkDir(target, dir, only ?? null);
    count += added;
    console.log(`linked ${added} entries from ${target} into ${dir}`);
  }

  console.log(`installed ${count} link(s). Restart OpenCode, then try /codex-setup.`);
}

function uninstall() {
  let count = 0;

  let existing;
  try {
    existing = fs.lstatSync(BIN_LINK);
  } catch {
    existing = undefined;
  }
  if (existing?.isSymbolicLink() && resolveLinkTarget(BIN_LINK) === COMPANION) {
    fs.unlinkSync(BIN_LINK);
    count += 1;
    console.log(`removed ${BIN_LINK}`);
  }

  for (const { target, dir, only } of LINK_PAIRS) {
    count += unlinkDir(target, dir, only ?? null);
  }

  console.log(`removed ${count} link(s).`);
}

const command = process.argv[2];
if (command === "uninstall") {
  uninstall();
} else if (command === undefined || command === "install" || command === "--help" || command === "-h") {
  if (command === "--help" || command === "-h") {
    console.log("Usage: node scripts/install.mjs [install|uninstall]");
  } else {
    install();
  }
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
