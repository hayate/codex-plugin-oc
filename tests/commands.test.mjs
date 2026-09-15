import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { isOwnedLink } from "../scripts/install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const DETERMINISTIC_COMMANDS = [
  { file: "codex-review.md", subcommand: "review" },
  { file: "codex-adversarial-review.md", subcommand: "adversarial-review" },
  { file: "codex-status.md", subcommand: "status" },
  { file: "codex-result.md", subcommand: "result" },
  { file: "codex-cancel.md", subcommand: "cancel" },
  { file: "codex-setup.md", subcommand: "setup" }
];

for (const { file, subcommand } of DETERMINISTIC_COMMANDS) {
  test(`${file} forwards to the companion through the bash tool without shell-interpolating raw arguments`, () => {
    const source = read(path.join("commands", file));

    assert.match(source, /^---\ndescription: .+\n---\n/m, "frontmatter with description");

    const template = source.split("---").slice(2).join("---").trim();
    assert.match(template, new RegExp(`codex-companion ${subcommand}`), "names the companion subcommand");
    assert.match(source, /bash tool/, "execution happens through the model's bash tool, not a shell template");
    assert.match(source, /verbatim/i, "model is instructed to pass the output through");
    assert.match(source, /Do not paraphrase/, "explicit pass-through instruction");
    assert.match(source, /forward ALL of them to the\s+companion exactly as given/, "explicit raw-argument forwarding contract");
    assert.match(source, /shell quoting/, "quoting requirement named");

    assert.doesNotMatch(template, /\$ARGUMENTS/, "raw arguments must never be shell-interpolated into a template");
    assert.doesNotMatch(template, /!`/, "no backtick shell interpolation");
    assert.doesNotMatch(source, /AskUserQuestion|CLAUDE_PLUGIN_ROOT|run_in_background/);
  });
}

test("session plugin exports the OpenCode session id into shell tool calls", async () => {
  const mod = await import(path.join(ROOT, "plugins", "codex", "codex-session-env.js"));
  const plugin = await mod.CodexSessionEnv();
  const hooks = plugin ?? {};
  assert.match("codex-session-env.js", /[^.]\.(ts|js)$/, "plugin file must match opencode's {plugin,plugins}/*.{ts,js} discovery glob");
  assert.equal(typeof hooks["shell.env"], "function", "plugin must implement shell.env");

  const output = { env: {} };
  await hooks["shell.env"]({ sessionID: "ses_test123", cwd: "/tmp" }, output);
  assert.equal(output.env.CODEX_COMPANION_SESSION_ID, "ses_test123");

  const output2 = { env: {} };
  await hooks["shell.env"]({ cwd: "/tmp" }, output2);
  assert.equal(output2.env.CODEX_COMPANION_SESSION_ID, undefined, "no sessionID means no session env injection");
});

test("session plugin pins the companion state root away from Claude Code's fallback", async (t) => {
  const stateBase = fs.mkdtempSync(path.join(os.tmpdir(), "oc-xdg-state-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateBase;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });

  const mod = await import(path.join(ROOT, "plugins", "codex", "codex-session-env.js"));
  const plugin = await mod.CodexSessionEnv();
  const hooks = plugin ?? {};

  const output = { env: {} };
  await hooks["shell.env"]({ sessionID: "ses_1", cwd: "/tmp" }, output);
  assert.equal(output.env.CODEX_PLUGIN_DATA, path.join(stateBase, "codex-plugin-oc"), "stable per-user state root, independent of the calling session");

  const output2 = { env: {} };
  await hooks["shell.env"]({ cwd: "/tmp" }, output2);
  assert.equal(output2.env.CODEX_PLUGIN_DATA, path.join(stateBase, "codex-plugin-oc"), "state root injected even without a session id");
});

test("session plugin never redirects state into the workspace and never clobbers an existing root", async (t) => {
  const previous = process.env.XDG_STATE_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });

  const importMod = async () => (await import(path.join(ROOT, "plugins", "codex", "codex-session-env.js"))).CodexSessionEnv;

  const homeFallback = path.join(os.homedir(), ".local", "state", "codex-plugin-oc");

  process.env.XDG_STATE_HOME = "";
  let hooks = await (await importMod())();
  let output = { env: {} };
  await hooks["shell.env"]({ cwd: "/tmp" }, output);
  assert.equal(output.env.CODEX_PLUGIN_DATA, homeFallback, "empty XDG_STATE_HOME falls back to the absolute home path");

  process.env.XDG_STATE_HOME = "relative/state";
  hooks = await (await importMod())();
  output = { env: {} };
  await hooks["shell.env"]({ cwd: "/tmp" }, output);
  assert.equal(output.env.CODEX_PLUGIN_DATA, homeFallback, "relative XDG_STATE_HOME falls back to the absolute home path");

  delete process.env.XDG_STATE_HOME;
  hooks = await (await importMod())();
  output = { env: { CODEX_PLUGIN_DATA: "/explicit/root" } };
  await hooks["shell.env"]({ cwd: "/tmp" }, output);
  assert.equal(output.env.CODEX_PLUGIN_DATA, "/explicit/root", "a previously supplied state root is preserved");
});

test("argument contracts name focus text and job ids where applicable", () => {
  const adversarial = read("commands/codex-adversarial-review.md");
  assert.match(adversarial, /focus text/, "adversarial-review must require focus text forwarding");
  for (const file of ["codex-status.md", "codex-result.md", "codex-cancel.md"]) {
    const source = read(path.join("commands", file));
    assert.match(source, /job id/, `${file} must name the positional job id`);
  }
  const review = read("commands/codex-review.md");
  assert.match(review, /Only flags are valid/, "review takes flags only");
});

test("rescue command routes to the codex-rescue subagent without model drift", () => {
  const source = read("commands/codex-rescue.md");

  assert.match(source, /agent: codex-rescue/);
  assert.match(source, /subtask: true/);
  const template = source.split("---").slice(2).join("---").trim();
  assert.equal(template, "$ARGUMENTS");
});

test("codex-rescue agent is a subagent that forwards verbatim and loads the runtime skills", () => {
  const source = read("agents/codex-rescue.md");

  assert.match(source, /name: codex-rescue/);
  assert.match(source, /mode: subagent/);
  assert.match(source, /codex-companion task/);
  assert.match(source, /codex-cli-runtime/);
  assert.match(source, /codex-result-handling/);
  assert.match(source, /verbatim/i);
  assert.match(source, /\/codex-setup/);
  assert.doesNotMatch(source, /CLAUDE_PLUGIN_ROOT/);
});

test("skills reference the companion on PATH, not a Claude plugin root", () => {
  const runtime = read("plugins/codex/skills/codex-cli-runtime/SKILL.md");
  const handling = read("plugins/codex/skills/codex-result-handling/SKILL.md");

  assert.doesNotMatch(runtime, /CLAUDE_PLUGIN_ROOT/);
  assert.match(runtime, /codex-companion task/);
  assert.doesNotMatch(handling, /Claude|claude/i);
});

test("install script links the companion, commands, agents, and skills", () => {
  const source = read("scripts/install.mjs");

  assert.match(source, /codex-companion/);
  assert.match(source, /commands/);
  assert.match(source, /agents/);
  assert.match(source, /skills/);
  assert.match(source, /uninstall/);
});

test("README documents the opencode surface and the upstream lineage", () => {
  const readme = read("README.md");

  assert.match(readme, /codex-plugin-cc/);
  assert.match(readme, /\/codex-review/);
  assert.match(readme, /\/codex-adversarial-review/);
  assert.match(readme, /never enters a shell template|no backtick\s+interpolation/i);
  assert.match(readme, /\/codex-rescue/);
  assert.match(readme, /install/);
  assert.doesNotMatch(readme, /\|\s*`\/codex:transfer`\s*\|/, "transfer is documented as dropped, not as a command row");
});

test("install script links into a clean home, is idempotent, warns on foreign files, and uninstalls", () => {
  
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-install-"));
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config")
  };

  const first = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], { env, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /installed \d+ link\(s\)/);

  const binLink = path.join(home, ".local", "bin", "codex-companion");
  assert.equal(fs.lstatSync(binLink).isSymbolicLink(), true);
  const dataDir = path.join(home, ".local", "share", "codex-plugin-oc");
  assert.ok(
    fs.readlinkSync(binLink).startsWith(`${dataDir}${path.sep}`),
    "links must point at the durable data-dir copy, not the npx cache or clone"
  );
  const cmdLink = fs.readlinkSync(path.join(home, ".config", "opencode", "commands", "codex-review.md"));
  assert.ok(cmdLink.startsWith(`${dataDir}${path.sep}`), "command links point at the data-dir copy");

  const second = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], { env, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /installed 0 link\(s\)/);

  const foreign = path.join(home, ".config", "opencode", "commands", "codex-review.md");
  fs.unlinkSync(foreign);
  fs.writeFileSync(foreign, "not ours\n");
  const third = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], { env, encoding: "utf8" });
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stderr, /skipping .*codex-review\.md: exists and is not our symlink/);

  const foreignBin = path.join(home, ".local", "bin", "codex-companion");
  fs.unlinkSync(foreignBin);
  fs.writeFileSync(foreignBin, "foreign\n");
  const collide = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], { env, encoding: "utf8" });
  assert.notEqual(collide.status, 0, "a companion collision must fail the install");
  assert.match(collide.stderr, /codex-companion/);
  assert.doesNotMatch(collide.stdout, /installed/, "collision must fail before linking anything");

  const remove = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs"), "uninstall"], { env, encoding: "utf8" });
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(fs.readFileSync(foreignBin, "utf8"), "foreign\n", "uninstall must not delete a foreign companion file");
  assert.equal(fs.readFileSync(foreign, "utf8"), "not ours\n", "uninstall must not touch foreign command files");

  const npmHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-npm-install-"));
  const npmEnv = { ...process.env, HOME: npmHome, XDG_CONFIG_HOME: path.join(npmHome, ".config") };
  fs.mkdirSync(path.join(npmHome, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(npmHome, ".config", "opencode", "opencode.jsonc"), JSON.stringify({ plugin: ["codex-plugin-oc"] }));
  const npmInstall = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], { env: npmEnv, encoding: "utf8" });
  assert.equal(npmInstall.status, 0, npmInstall.stderr);
  assert.equal(
    fs.lstatSync(path.join(npmHome, ".config", "opencode", "plugins", "codex-session-env.js"), { throwIfNoEntry: false }),
    undefined,
    "plugin file is not linked when the npm package is referenced in the opencode config"
  );
  assert.equal(fs.lstatSync(path.join(npmHome, ".local", "bin", "codex-companion")).isSymbolicLink(), true, "bin link still installed");

  const commentHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-comment-install-"));
  const commentEnv = { ...process.env, HOME: commentHome, XDG_CONFIG_HOME: path.join(commentHome, ".config") };
  fs.mkdirSync(path.join(commentHome, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(commentHome, ".config", "opencode", "opencode.jsonc"),
    '{\n  // "codex-plugin-oc" - commented out, must not suppress the plugin link\n  "theme": "dark",\n  "notes": "see codex-plugin-oc docs"\n}'
  );
  const commentInstall = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], { env: commentEnv, encoding: "utf8" });
  assert.equal(commentInstall.status, 0, commentInstall.stderr);
  assert.equal(
    fs.lstatSync(path.join(commentHome, ".config", "opencode", "plugins", "codex-session-env.js")).isSymbolicLink(),
    true,
    "commented-out or unrelated mentions must not suppress the plugin link"
  );

  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "oc-uninstall-"));
  const cleanEnv = { ...process.env, HOME: clean, XDG_CONFIG_HOME: path.join(clean, ".config") };
  const relink = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], { env: cleanEnv, encoding: "utf8" });
  assert.equal(relink.status, 0, relink.stderr);
  const cleanBin = path.join(clean, ".local", "bin", "codex-companion");
  assert.equal(fs.lstatSync(cleanBin).isSymbolicLink(), true);
  const cleanRemove = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs"), "uninstall"], { env: cleanEnv, encoding: "utf8" });
  assert.equal(cleanRemove.status, 0, cleanRemove.stderr);
  assert.equal(fs.lstatSync(cleanBin, { throwIfNoEntry: false }), undefined, "uninstall removes our own links");
});

test("cross-version upgrade replaces every owned link in place", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-upgrade-"));
  const base = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  const dataDir = path.join(home, ".local", "share", "codex-plugin-oc");

  const vA = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], {
    env: { ...base, CODEX_PLUGIN_OC_VERSION: "0.0.1" },
    encoding: "utf8"
  });
  assert.equal(vA.status, 0, vA.stderr);
  assert.ok(fs.existsSync(path.join(dataDir, "0.0.1")), "version A materialized");

  const vB = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], {
    env: { ...base, CODEX_PLUGIN_OC_VERSION: "0.0.2" },
    encoding: "utf8"
  });
  assert.equal(vB.status, 0, vB.stderr);
  assert.match(vB.stdout, /installed \d+ link\(s\)/, "upgrade must not fail closed on its own version-A links");
  assert.ok(fs.existsSync(path.join(dataDir, "0.0.2")), "version B materialized");
  assert.equal(fs.existsSync(path.join(dataDir, "0.0.1")), false, "stale version A directory removed");

  const binLink = path.join(home, ".local", "bin", "codex-companion");
  assert.ok(fs.readlinkSync(binLink).startsWith(path.join(dataDir, "0.0.2") + path.sep), "bin link moved to B");
  for (const rel of [
    path.join("commands", "codex-review.md"),
    path.join("agents", "codex-rescue.md"),
    path.join("skills", "codex-cli-runtime"),
    path.join("plugins", "codex-session-env.js")
  ]) {
    const link = path.join(home, ".config", "opencode", rel);
    assert.ok(
      fs.readlinkSync(link).startsWith(path.join(dataDir, "0.0.2") + path.sep),
      `${rel} moved to B`
    );
  }
});

test("legacy clone-layout links are migrated, not rejected", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-legacy-"));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };

  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "opencode", "commands"), { recursive: true });
  fs.symlinkSync(
    path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs"),
    path.join(home, ".local", "bin", "codex-companion")
  );
  fs.symlinkSync(
    path.join(ROOT, "commands", "codex-review.md"),
    path.join(home, ".config", "opencode", "commands", "codex-review.md")
  );

  const result = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const dataDir = path.join(home, ".local", "share", "codex-plugin-oc");
  assert.ok(fs.readlinkSync(path.join(home, ".local", "bin", "codex-companion")).startsWith(dataDir + path.sep), "legacy bin link migrated");
  assert.ok(fs.readlinkSync(path.join(home, ".config", "opencode", "commands", "codex-review.md")).startsWith(dataDir + path.sep), "legacy command link migrated");

  const remove = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs"), "uninstall"], { env, encoding: "utf8" });
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(fs.lstatSync(path.join(home, ".local", "bin", "codex-companion"), { throwIfNoEntry: false }), undefined, "uninstall removes migrated links");
});

test("owned-link check survives a symlinked data-dir prefix (macOS /var -> /private/var)", () => {
  // macOS exposes the durable state dir under /var/... (logical) while
  // fs.realpathSync resolves it to /private/var/... (physical). A link the
  // installer just created must still be recognised as owned, so re-install
  // and uninstall work. Encode that mismatch deterministically here.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oc-phys-"));
  const physicalRoot = path.join(base, "real");
  const logicalPrefix = path.join(base, "link");
  fs.mkdirSync(physicalRoot, { recursive: true });
  fs.symlinkSync(physicalRoot, logicalPrefix, "dir");

  const dataDir = path.join(logicalPrefix, "codex-plugin-oc");
  const versioned = path.join(dataDir, "1.0.1", "plugins", "codex", "scripts");
  fs.mkdirSync(versioned, { recursive: true });
  const companion = path.join(versioned, "codex-companion.mjs");
  fs.writeFileSync(companion, "// engine\n");

  const binDir = path.join(base, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binLink = path.join(binDir, "codex-companion");
  // install writes the LOGICAL path as the link target...
  fs.symlinkSync(companion, binLink);

  const prevData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = logicalPrefix;
  try {
    assert.equal(isOwnedLink(binLink), true, "a just-created data-dir link is owned despite the physical/logical split");
  } finally {
    if (prevData === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = prevData;
    }
  }
});

test("uninstall removes legacy links written through a clone alias", () => {
  // End-to-end for the uninstall side of the alias fix: a link whose target
  // is spelled through an alias of the checkout (macOS /tmp -> /private/tmp)
  // must still be removed by `uninstall`, and only the link - the real file
  // in the checkout survives.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-alias-uninstall-"));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };

  const first = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs")], { env, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);

  const alias = fs.mkdtempSync(path.join(os.tmpdir(), "oc-alias-uninstall-clone-"));
  fs.rmdirSync(alias);
  fs.symlinkSync(ROOT, alias, "dir");

  const link = path.join(home, ".config", "opencode", "commands", "codex-review.md");
  assert.ok(fs.readlinkSync(link).startsWith(path.join(home, ".local", "share", "codex-plugin-oc") + path.sep), "install created a data-dir link");
  // Rewrite the link through the clone alias, as a legacy clone install would have.
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(alias, "commands", "codex-review.md"), link);
  assert.equal(fs.realpathSync(link), path.join(ROOT, "commands", "codex-review.md"), "the alias-spelled link resolves into the checkout");

  const remove = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs"), "uninstall"], { env, encoding: "utf8" });
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined, "uninstall removes the alias-spelled link");
  assert.ok(fs.existsSync(path.join(ROOT, "commands", "codex-review.md")), "the real checkout file survives uninstall");

  fs.unlinkSync(alias);
});

test("owned-link check accepts legacy links written through a clone alias", () => {
  // A legacy clone install may have written link targets through an ALIAS of
  // the checkout (on macOS /tmp -> /private/tmp, so a target written as
  // /tmp/<checkout>/... resolves to /private/tmp/<checkout>/... while
  // SOURCE_ROOT is the physical form). Canonicalising only one side of the
  // comparison rejects such an owned link: re-install would fail closed and
  // uninstall would leave it behind.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oc-alias-"));
  const alias = path.join(base, "clone-alias");
  fs.symlinkSync(ROOT, alias, "dir");

  const realFile = path.join(ROOT, "commands", "codex-review.md");
  fs.mkdirSync(path.join(base, "links"), { recursive: true });

  const throughAlias = path.join(base, "links", "via-alias.md");
  fs.symlinkSync(path.join(alias, "commands", "codex-review.md"), throughAlias);
  assert.equal(isOwnedLink(throughAlias), true, "a link through a clone alias is owned");

  const indirect = path.join(base, "links", "indirect.md");
  fs.symlinkSync(path.join(base, "links", "via-alias.md"), indirect);
  assert.equal(isOwnedLink(indirect), true, "an indirect chain through an alias is owned");

  const dangling = path.join(base, "links", "dangling.md");
  fs.symlinkSync(path.join(alias, "commands", "no-such-file.md"), dangling);
  assert.equal(isOwnedLink(dangling), true, "a dangling link through an alias is owned (logical form kept)");

  const foreign = path.join(base, "links", "foreign.md");
  fs.symlinkSync(realFile, foreign);
  assert.equal(isOwnedLink(foreign), true, "a direct link into the source root is owned");

  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-alias-foreign-"));
  fs.writeFileSync(path.join(foreignDir, "codex-review.md"), "not ours\n");
  const trulyForeign = path.join(base, "links", "truly-foreign.md");
  fs.symlinkSync(path.join(foreignDir, "codex-review.md"), trulyForeign);
  assert.equal(isOwnedLink(trulyForeign), false, "a link into an unrelated file is foreign");

  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(foreignDir, { recursive: true, force: true });
});
