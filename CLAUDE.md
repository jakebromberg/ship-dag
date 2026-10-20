# CLAUDE.md

## Shared rules live in the plugin

A rule that `plugins/ship-dag-eta/` needs has exactly one definition, in `plugins/ship-dag-eta/lib/`, and `scripts/` re-exports it (as `scripts/eta/*.mjs` and `scripts/lib/{run-id,ref,failure}.mjs` do). An installed plugin cannot import outside its folder, so never copy a rule into the plugin; move it there and re-export it. Plugin lib modules take no Node imports. A change to the run-family rule, `parseRef` or `artifactStem` is a one-place edit in the plugin, tested through the `scripts/lib` tests.
