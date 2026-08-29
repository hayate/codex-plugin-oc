---
description: Run a steerable Codex challenge review of the current work
---
Run `codex-companion adversarial-review` with the bash tool. OpenCode appends
the user's raw arguments to this prompt when present; forward ALL of them to the
companion exactly as given, using shell quoting that preserves spaces and special
characters. Valid inputs are flags (--base <ref>, --scope <auto|working-tree|branch>, --wait, --background, --json, --model <model>) followed by optional free-form focus text. The focus text is the last positional content and must be passed through word for word.

Return the command output verbatim. Do not paraphrase, summarize, add
commentary, or fix anything it reports.
