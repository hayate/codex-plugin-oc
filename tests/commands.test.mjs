import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";

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
  assert.match(readme, /shell interpolation/);
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
