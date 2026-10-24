# CLAUDE.md

## Shared rules live in the plugin

A rule that `plugins/ship-dag-eta/` needs has exactly one definition, in `plugins/ship-dag-eta/lib/`, and `scripts/` re-exports it (as `scripts/eta/*.mjs` and `scripts/lib/{run-id,ref,failure}.mjs` do). An installed plugin cannot import outside its folder, so never copy a rule into the plugin; move it there and re-export it. Plugin lib modules take no Node imports. A change to the run-family rule, `parseRef` or `artifactStem` is a one-place edit in the plugin, tested through the `scripts/lib` tests.

## No machine-specific names or paths

This repo is public, and it runs on any machine. Never commit a machine's host name or ssh alias, a user name, or an absolute path under one person's home (`/Users/<name>`, `/home/<name>`). Derive a home path from `os.homedir()` in code or `$HOME` in shell, and write `~/…` in prose. Fixtures and examples use a placeholder home (`/Users/me`, `/home/me`; `PLACEHOLDER_HOMES` in `scripts/no-home-paths.test.mjs`, which fails on any other home in a tracked file). Remote hosts go in the host registry outside the repo (`~/.config/ship-dag/hosts.json`, read by `scripts/lib/hosts.mjs`); `references/hosts.example.json` holds a placeholder. Issue and PR text follows the same rule.
