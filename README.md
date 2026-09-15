# codex-plugin-oc

[![npm version](https://img.shields.io/npm/v/codex-plugin-oc)](https://www.npmjs.com/package/codex-plugin-oc)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Use Codex from OpenCode to review code or delegate tasks - frontier-model
review for code you wrote with any model.

A port of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).
The review and delegation engine is vendored from upstream (Apache-2.0, see
LICENSE and NOTICE) and is host-agnostic. It reads only `CODEX_PLUGIN_DATA`
for its state directory and, optionally, `CODEX_COMPANION_SESSION_ID` to
scope jobs per session. The OpenCode integration - the installer, the
session-env hook plugin, and the command, agent, and skill formats - is what
this package ships. Other coding hosts can use the engine by setting those
variables and running `codex-companion`.

## Versioning

The version number is the upstream version the vendored engine was ported
from (currently `openai/codex-plugin-cc` 1.0.6). When upstream releases a new
version and this repo re-syncs the engine, the version is bumped to match it,
so the number always answers "which upstream release are we on?". Check for
re-syncs by comparing `plugins/codex/` against the upstream release you are
porting and recording the merge in the CHANGELOG. `npm run check-version`
keeps the three release manifests in agreement; CI enforces it.

If you are reviewing code written by a weaker or local model, see
[opencode-floor-review](https://github.com/hayate/opencode-floor-review) -
this plugin raises the ceiling on frontier code; that one raises the floor
on plausible-looking code.

## What you get

| OpenCode command | Upstream equivalent | What it does |
| --- | --- | --- |
| `/codex-review` | `/codex:review` | Read-only Codex review of your working tree or a branch (`--base <ref>`) |
| `/codex-adversarial-review` | `/codex:adversarial-review` | Steerable challenge review with focus text |
| `/codex-rescue` | `/codex:rescue` | Hands a task to Codex through the `codex-rescue` subagent |
| `/codex-status` | `/codex:status` | Shows running and recent Codex jobs for this repository |
| `/codex-result` | `/codex:result` | Shows the stored output of a finished job |
| `/codex-cancel` | `/codex:cancel` | Cancels an active background job |
| `/codex-setup` | `/codex:setup` | Checks that Codex is installed and authenticated |

Plus the `codex-rescue` subagent, three internal skills
(`codex-cli-runtime`, `codex-result-handling`, `gpt-5-4-prompting`), and
the `codex-session-env` hook plugin.

## Requirements

- Node.js 18.18+
- A ChatGPT subscription (including Free) or OpenAI API key. Usage counts
  toward your Codex limits. See
  [Codex pricing](https://developers.openai.com/codex/pricing).
- The Codex CLI: `npm install -g @openai/codex`, then `codex login`.

## Which model reviews

The reviewer is the Codex CLI itself, on whatever account `codex login`
authenticated. Its model and reasoning effort come from Codex's own
config (`~/.codex/config.toml`, with per-project `.codex/config.toml`
overrides) - not from your OpenCode model settings.

## Install

### npm (recommended)

Add the package to your OpenCode config (this loads the hook plugin), then
run the installer for the file surface:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["codex-plugin-oc"]
}
```

```bash
npx codex-plugin-oc@latest install
```

The installer copies the runtime surface into a durable per-version
directory under `$XDG_DATA_HOME/codex-plugin-oc` (or
`~/.local/share/codex-plugin-oc`) and symlinks from there, so clearing
the npx cache never breaks an existing installation, and re-running it
upgrades in place (links owned by an older version are replaced and the
old version directory is removed). It then links:

- `codex-companion` into `~/.local/bin/` (make sure it is on your `PATH`;
  the install fails closed if that path holds a file it does not own)
- `commands/*.md` into `~/.config/opencode/commands/`
- `agents/codex-rescue.md` into `~/.config/opencode/agents/`
- the skills into `~/.config/opencode/skills/`

The hook plugin is not linked when the config already references
`codex-plugin-oc` (the config entry loads it); the detection parses the
JSONC `plugin` array, so comments or unrelated strings do not suppress
it. Remove with `npx codex-plugin-oc uninstall` (removes all links the
plugin owns and the data directory).

### From source

```bash
git clone https://github.com/hayate/codex-plugin-oc.git ~/srv/codex-plugin-oc
node ~/srv/codex-plugin-oc/scripts/install.mjs
```

The source install also links `codex-session-env.js` into
`~/.config/opencode/plugins/`.

Then restart OpenCode and run `/codex-setup` to verify.

## How commands execute

Commands instruct the model to run `codex-companion <subcommand>` through
the bash tool and return the output verbatim. No user text ever enters a
shell template: templates carry no `$ARGUMENTS` and no backtick
interpolation, OpenCode appends raw arguments as prompt text, and each
command states an explicit argument contract (flags, focus text, job ids)
plus a shell-quoting requirement. This is deliberate: OpenCode's template
pipeline cannot execute shell blocks with untrusted arguments without an
injection surface (backticks, quotes, `$()`), so execution is
model-mediated rather than deterministic.

Reviews run in the foreground TUI session. Only `task` detaches
(`--background` returns a job id immediately; check it with
`/codex-status`, fetch it with `/codex-result`). The review commands
accept `--background` for upstream CLI compatibility but it does not
detach under OpenCode.

## State, sessions, and coexistence

The `codex-session-env` plugin injects two variables into every shell
tool call:

- `CODEX_PLUGIN_DATA` - a stable per-user state root under
  `$XDG_STATE_HOME/codex-plugin-oc` (or `~/.local/state/codex-plugin-oc`;
  an empty or relative `XDG_STATE_HOME` falls back to the home path, and
  a value already supplied by another plugin or the environment is
  preserved). Job registries, logs, and broker sessions live there
  instead of upstream's `/tmp/codex-companion` fallback: state survives
  reboots, is private to the user (no cross-user `/tmp` collisions or
  exposure), and honors XDG.
- `CODEX_COMPANION_SESSION_ID` - the OpenCode session id, so jobs are
  scoped per session like upstream's Claude hook behavior.

This also keeps the port from sharing state with the original
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) when
both run on one machine: keep using the original inside Claude Code
(its own plugin cache paths and `CLAUDE_PLUGIN_DATA` per session) and
this port inside OpenCode. Bare-terminal invocations of the companion
still use the `/tmp/codex-companion` fallback, matching upstream.

## Security and what runs on your machine

- The companion runs the global `codex` binary on your machine with your
  existing Codex authentication. Nothing else is executed: the package has
  zero runtime dependencies and makes no network calls of its own; only
  Codex's app server is contacted.
- Reviews (`/codex-review`, `/codex-adversarial-review`) are read-only.
- `/codex-rescue` defaults to write-capable Codex runs, so delegated tasks
  can edit files - that is its purpose. Use `task` without `--write` for
  read-only investigation.
- All job state, logs, and broker sessions live under
  `$XDG_STATE_HOME/codex-plugin-oc` (see below). No telemetry of any kind.

## Check it landed

```bash
opencode debug config | jq -r '.command | keys[] | select(startswith("codex-"))'
```

then `/codex-setup` to verify the CLI and your login.

## Troubleshooting

OpenCode hides plugin and command failures - a broken install is usually
silent. Diagnose with:

```bash
opencode debug config --print-logs --log-level ERROR 2>&1 | grep -i plugin
```

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/codex-setup` says Codex missing | The CLI is not installed or not on `PATH` | `npm install -g @openai/codex`, restart OpenCode |
| `/codex-setup` says not logged in | No ChatGPT/API-key login | Run `codex login` in a terminal |
| `/codex-status` reports `No job found` | You are in a different directory than the launch one, or the session moved | Run status from the same project directory; job state is keyed per workspace and session |
| Commands do not exist at all | The installer never ran | `npx codex-plugin-oc@latest install` |

## Dropped vs upstream

- `/codex:transfer` - needs Claude Code's transcript importer; OpenCode has
  no equivalent session format.
- The stop-time review gate - Claude Code's `Stop` hook has no OpenCode
  counterpart.
- The `SessionStart`/`SessionEnd` hooks - replaced by the
  `codex-session-env` plugin described above.

## Versioning and CI

- `npm run bump-version <x.y.z>` updates package.json, package-lock.json,
  and `plugins/codex/plugin.json`; `npm run check-version` verifies they
  agree.
- Tests run on every push and pull request; tagging `vX.Y.Z` publishes to
  npm with provenance (GitHub OIDC trusted publishing, no long-lived
  token) and creates a GitHub release after the tag matches
  package.json's version exactly, the manifests agree, and tests pass.

## Upstream tracking

The engine under `plugins/codex/scripts/` is vendored from
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) and
modified only where the host coupling lives (env var names, client info,
removed transfer/hook plumbing, env-parameter threading for testability).
To sync:

```bash
git fetch upstream
git diff upstream/main -- plugins/codex/scripts
```

## Contributing

Issues and PRs are welcome at
[hayate/codex-plugin-oc](https://github.com/hayate/codex-plugin-oc). The
test suite is `npm test`; engine changes should stay minimal so the
vendored tree keeps syncing with upstream (see above).

## License

Apache-2.0. Portions copyright OpenAI and contributors (see NOTICE);
OpenCode surface copyright Andrea Belvedere.
