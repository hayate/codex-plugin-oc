#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = path.join(os.homedir(), ".local", "bin");
const BIN_LINK = path.join(BIN_DIR, "codex-companion");

function opencodeDir() {
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
}

function dataDir() {
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "codex-plugin-oc")
    : path.join(os.homedir(), ".local", "share", "codex-plugin-oc");
}

function readVersion() {
  return process.env.CODEX_PLUGIN_OC_VERSION
    ?? JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "plugins", "codex", "plugin.json"), "utf8")).version;
}

// Canonicalise a path that may not exist. fs.realpathSync fails on a dangling
// path, so resolve the deepest existing ancestor and re-append the remainder.
// This is what lets a stale link into a moved checkout still be recognised as
// ours. Returns the input unchanged if nothing can be resolved.
export function canonicalizePath(p) {
  let base = p;
  let remainder = "";
  for (;;) {
    try {
      const resolved = fs.realpathSync.native(base);
      return remainder ? `${resolved}${remainder}` : resolved;
    } catch {
      const parent = path.dirname(base);
      if (parent === base) {
        return p;
      }
      remainder = `${path.sep}${path.basename(base)}${remainder}`;
      base = parent;
    }
  }
}

// The ownership roots, in every path form the platform can spell them.
// import.meta.url (and XDG_DATA_HOME) may name a dir through an alias - on
// macOS /tmp -> /private/tmp - while a link target written through the other
// alias is a different string. Comparing one spelling against the other
// rejects a link this plugin created itself, so each root is offered both
// as written and canonicalised.
function ownershipRoots(root) {
  const forms = [root];
  try {
    const canonical = fs.realpathSync.native(root);
    if (canonical !== root) {
      forms.push(canonical);
    }
  } catch {
    // A not-yet-created root (fresh install) has only its as-written form.
  }
  return forms;
}

export function isOwnedLink(linkPath) {
  const target = resolveLinkTarget(linkPath);
  if (target == null) {
    return false;
  }
  // canonicalizePath resolves alias spellings and indirect chains, and still
  // works when the final target is missing (a stale link into a moved
  // checkout) by resolving the deepest existing ancestor.
  const canonicalTarget = canonicalizePath(target);
  const roots = [...ownershipRoots(dataDir()), ...ownershipRoots(SOURCE_ROOT)];
  return roots.some(
    (root) => target.startsWith(`${root}${path.sep}`) || canonicalTarget.startsWith(`${root}${path.sep}`)
  );
}

function replaceLink(target, linkPath) {
  const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing === undefined) {
    fs.symlinkSync(target, linkPath);
    return "linked";
  }
  if (existing.isSymbolicLink() && resolveLinkTarget(linkPath) === target) {
    return "present";
  }
  if (existing.isSymbolicLink() && isOwnedLink(linkPath)) {
    fs.unlinkSync(linkPath);
    fs.symlinkSync(target, linkPath);
    return "replaced";
  }
  return "foreign";
}

function installRoot() {
  return path.join(dataDir(), readVersion());
}

function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inBlockComment = false;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function configReferencesPackage() {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const file = path.join(opencodeDir(), name);
    if (!fs.existsSync(file)) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(stripJsonc(fs.readFileSync(file, "utf8")));
    } catch {
      continue;
    }
    const plugin = parsed.plugin;
    const entries = Array.isArray(plugin) ? plugin : plugin == null ? [] : [plugin];
    const referenced = entries.some((entry) => {
      const spec = Array.isArray(entry) ? entry[0] : entry;
      return typeof spec === "string" && (spec === "codex-plugin-oc" || spec.startsWith("codex-plugin-oc@"));
    });
    if (referenced) {
      return true;
    }
  }
  return false;
}

function copyTree(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function materialize() {
  const root = installRoot();
  const source = {
    commands: path.join(SOURCE_ROOT, "commands"),
    agents: path.join(SOURCE_ROOT, "agents"),
    engine: path.join(SOURCE_ROOT, "plugins", "codex")
  };

  copyTree(source.commands, path.join(root, "commands"));
  copyTree(source.agents, path.join(root, "agents"));
  copyTree(source.engine, path.join(root, "plugins", "codex"));

  const companion = path.join(root, "plugins", "codex", "scripts", "codex-companion.mjs");
  fs.chmodSync(companion, 0o755);

  const currentVersion = readVersion();
  for (const entry of fs.readdirSync(dataDir(), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== currentVersion && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(entry.name)) {
      fs.rmSync(path.join(dataDir(), entry.name), { recursive: true, force: true });
    }
  }

  return { root, source, companion, skills: path.join(root, "plugins", "codex", "skills"), plugin: path.join(root, "plugins", "codex", "codex-session-env.js") };
}

function linkIntoDir(targetDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const linkPath = path.join(destDir, entry.name);
    const target = path.join(targetDir, entry.name);
    const outcome = replaceLink(target, linkPath);
    if (outcome === "foreign") {
      console.warn(`skipping ${linkPath}: exists and is not our symlink`);
      continue;
    }
    if (outcome !== "present") {
      count += 1;
    }
  }
  return count;
}

function resolveLinkTarget(linkPath) {
  let raw;
  try {
    raw = fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
  // Keep the target as written (logical), not realpathSync'd (physical):
  // dataDir() and SOURCE_ROOT are logical, and on macOS /var -> /private/var,
  // so a physical target would never match a logical prefix and the plugin's
  // own links would look foreign (re-install fails, uninstall keeps them).
  return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(linkPath), raw);
}

function install() {
  const { root, companion, skills, plugin } = materialize();
  let count = 0;

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const binOutcome = replaceLink(companion, BIN_LINK);
  if (binOutcome === "foreign") {
    console.error(`${BIN_LINK} exists and is not this plugin's symlink.`);
    console.error(`Move or remove it, then rerun: ${process.argv[1]}`);
    process.exitCode = 1;
    return 0;
  }
  if (binOutcome !== "present") {
    count += 1;
    console.log(`${binOutcome} ${BIN_LINK} -> ${companion}`);
  }
  if (!(process.env.PATH ?? "").split(path.delimiter).includes(BIN_DIR)) {
    console.warn(`${BIN_DIR} is not on PATH; the codex-companion commands will not resolve. Add it and restart OpenCode.`);
  }

  count += linkIntoDir(path.join(root, "commands"), path.join(opencodeDir(), "commands"));
  count += linkIntoDir(path.join(root, "agents"), path.join(opencodeDir(), "agents"));
  count += linkIntoDir(skills, path.join(opencodeDir(), "skills"));

  if (configReferencesPackage()) {
    console.log('skipping the hook plugin: "codex-plugin-oc" is referenced in the opencode config and loads the plugin itself');
  } else {
    const pluginDir = path.join(opencodeDir(), "plugins");
    fs.mkdirSync(pluginDir, { recursive: true });
    const pluginLink = path.join(pluginDir, "codex-session-env.js");
    const pluginOutcome = replaceLink(plugin, pluginLink);
    if (pluginOutcome === "foreign") {
      console.warn(`skipping ${pluginLink}: exists and is not our symlink`);
    } else if (pluginOutcome !== "present") {
      count += 1;
    }
  }

  console.log(`installed ${count} link(s) from ${root}. Restart OpenCode, then try /codex-setup.`);
  return count;
}

function unlinkIfOwned(linkPath) {
  let existing;
  try {
    existing = fs.lstatSync(linkPath);
  } catch {
    return 0;
  }
  if (!existing.isSymbolicLink()) {
    return 0;
  }
  if (isOwnedLink(linkPath)) {
    fs.unlinkSync(linkPath);
    return 1;
  }
  return 0;
}

function uninstall() {
  let count = 0;
  count += unlinkIfOwned(BIN_LINK);
  for (const dir of ["commands", "agents", "skills", "plugins"]) {
    const destDir = path.join(opencodeDir(), dir);
    if (!fs.existsSync(destDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
      count += unlinkIfOwned(path.join(destDir, entry.name));
    }
  }
  fs.rmSync(dataDir(), { recursive: true, force: true });
  console.log(`removed ${count} link(s) and ${dataDir()}.`);
  return count;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const command = process.argv[2];
  if (command === "uninstall") {
    uninstall();
  } else if (command === undefined || command === "install" || command === "--help" || command === "-h") {
    if (command === "--help" || command === "-h") {
      console.log("Usage: codex-plugin-oc [install|uninstall]");
    } else {
      install();
    }
  } else {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
  }
}
