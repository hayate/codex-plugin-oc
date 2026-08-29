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

Plus the `codex-rescue` subagent and three internal skills
(`codex-cli-runtime`, `codex-result-handling`, `gpt-5-4-prompting`).

## Requirements

- Node.js 18.18+
- A ChatGPT subscription (including Free) or OpenAI API key. Usage counts
  toward your Codex limits. See
  [Codex pricing](https://developers.openai.com/codex/pricing).
- The Codex CLI: `npm install -g @openai/codex`, then `codex login`.

## Install

Clone and link into your OpenCode config:

```bash
git clone https://github.com/hayate/codex-plugin-oc.git ~/srv/codex-plugin-oc
node ~/srv/codex-plugin-oc/scripts/install.mjs
```

The install script symlinks:

- `codex-companion` into `~/.local/bin/` (make sure it is on your `PATH`)
- `commands/*.md` into `~/.config/opencode/commands/`
- `agents/codex-rescue.md` into `~/.config/opencode/agents/`
- the skills into `~/.config/opencode/skills/`

Then restart OpenCode and run `/codex-setup` to verify. Remove with
`node scripts/install.mjs uninstall`.

The commands are deterministic shell passthroughs: they run
`codex-companion <subcommand> $ARGUMENTS` directly, with no model in the
loop. Backgrounding is handled by the companion itself (`--background` on
review, adversarial-review, and task returns a job id; check it with
`/codex-status`, fetch it with `/codex-result`).

## Dropped vs upstream

- `/codex:transfer` - needs Claude Code's transcript importer; OpenCode has
  no equivalent session format.
- The stop-time review gate - Claude Code's `Stop` hook has no OpenCode
  counterpart.
- The `SessionStart`/`SessionEnd` hooks - OpenCode does not expose Claude's
  transcript lifecycle. Job state is scoped per workspace.

## Upstream tracking

The engine under `plugins/codex/scripts/` is vendored from
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) and
modified only where the host coupling lives (env var names, client info,
removed transfer/hook plumbing). To sync:

```bash
git fetch upstream
git diff upstream/main -- plugins/codex/scripts
```

## License

Apache-2.0. Portions copyright OpenAI and contributors (see NOTICE);
OpenCode surface copyright Andrea Belvedere.
