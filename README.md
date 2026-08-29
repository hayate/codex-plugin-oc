# codex-plugin-oc

Use Codex from OpenCode to review code or delegate tasks.

A port of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
for [OpenCode](https://opencode.ai). The review and delegation engine is
vendored from upstream (Apache-2.0, see LICENSE and NOTICE); the command
surface is rewritten for OpenCode's command, agent, and skill formats.

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

## License

Apache-2.0. Portions copyright OpenAI and contributors (see NOTICE);
OpenCode surface copyright Andrea Belvedere.
