# Changelog

Version numbers track the upstream `openai/codex-plugin-cc` release the
vendored engine was ported from. Port-side fixes ride along at the same
version until the next re-sync.

## 1.0.6

- Version now matches the ported upstream release (openai/codex-plugin-cc
  1.0.6); see "Versioning" in the README.
- Fix: installer recognised its own links across the macOS `/var` ->
  `/private/var` split. `resolveLinkTarget` now compares the link target as
  written (logical) against the logical `dataDir()` / `SOURCE_ROOT` prefixes
  instead of the `realpathSync` (physical) result, so re-install is
  idempotent and uninstall removes migrated links on macOS.
- Test: `scripts/install.mjs` gained a main guard so it can be imported by
  the test suite without running the install; new unit test covers the
  logical/physical link-target split on every platform.

## 1.0.1

- Test suite made immune to the plugin's ambient environment.

## 1.0.0

- Initial version of the Codex plugin for OpenCode: ported from
  openai/codex-plugin-cc 1.0.0 with the command surface rewritten for
  OpenCode's command, agent, and skill formats.
