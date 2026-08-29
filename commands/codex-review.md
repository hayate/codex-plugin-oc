---
description: Run a Codex code review against local git state
---
Run `codex-companion review` with the bash tool. OpenCode appends
the user's raw arguments to this prompt when present; forward ALL of them to the
companion exactly as given, using shell quoting that preserves spaces and special
characters. Only flags are valid: --base <ref>, --scope <auto|working-tree|branch>, --wait, --background, --json, --model <model>, --cwd <dir>.

Return the command output verbatim. Do not paraphrase, summarize, add
commentary, or fix anything it reports.
