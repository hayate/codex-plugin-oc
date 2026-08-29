---
description: Show the stored output of a finished Codex job
---
Run `codex-companion result` with the bash tool. OpenCode appends
the user's raw arguments to this prompt when present; forward ALL of them to the
companion exactly as given, using shell quoting that preserves spaces and special
characters. Valid inputs are an optional job id plus flags (--json, --cwd <dir>).

Return the command output verbatim. Do not paraphrase, summarize, add
commentary, or fix anything it reports.
