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
  test(`${file} is a deterministic shell passthrough to the companion`, () => {
    const source = read(path.join("commands", file));

    assert.match(source, /^---\ndescription: .+\n---\n/m, "frontmatter with description");

    const template = source.split("---").slice(2).join("---").trim();
    assert.equal(template, `!codex-companion ${subcommand} $ARGUMENTS`);

    assert.doesNotMatch(source, /AskUserQuestion|Bash\(|CLAUDE_PLUGIN_ROOT|run_in_background|node /);
    assert.doesNotMatch(source, /Do not fix issues|verbatim/i, "no model instructions in a passthrough command");
  });
}

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

  const remove = spawnSync("node", [path.join(ROOT, "scripts", "install.mjs"), "uninstall"], { env, encoding: "utf8" });
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(fs.lstatSync(binLink, { throwIfNoEntry: false }), undefined);
  assert.equal(fs.readFileSync(foreign, "utf8"), "not ours\n", "uninstall must not touch foreign files");
});
