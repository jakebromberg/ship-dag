You are implementing GitHub issue #{{ISSUE_NUMBER}} in a fresh, disposable git worktree that has **already been created and checked out for you** — your current working directory is the correct repo's worktree, forked from that repo's own base branch. `gh` infers the repo from this directory, so bare `gh issue view {{ISSUE_NUMBER}}` / `gh pr create` target the right repo; you do not need to `cd` elsewhere or clone anything.

Implementation plan from triage:

> {{DESCRIPTION}}

Steps:

1. Read the repo's and the touched package's `CLAUDE.md`, and the existing patterns in the module you're changing. Match them — naming, comment density, test idiom.
2. Read the canonical issue: `gh issue view {{ISSUE_NUMBER}} --json title,body,labels`. Follow referenced issues enough to understand scope and acceptance criteria. The triage plan above is a starting point, not a substitute for the issue body.
3. Implement **test-first**: a failing test → the smallest correct change that passes it → the passing test. No drive-by refactors — every change outside the issue's scope is something the review gate will flag.
4. Run the repo's local CI (lint / format-check / typecheck / tests, or `npm run ci:*` / `pytest` / `xcodebuild test` as the repo dictates). Fix red before pushing. Never push known-red to bait the review.
5. Commit as a **ghost-writer — no Claude / AI / "Co-Authored-By" attribution anywhere** in the commit message, PR body, or code comments. Push a dedicated branch and open a PR whose body contains `Closes #{{ISSUE_NUMBER}}` and cross-references the issue. Do not wrap commit-message or markdown paragraphs with hard line breaks.
6. **If mid-implementation you hit a genuine open question** the issue and repo conventions don't answer (an ambiguous spec, an architectural fork, a new third-party dependency), **STOP** — leave a comment on the issue stating the question and exit without pushing a guess. A wrong guess is more expensive to unwind than a paused issue.

The orchestrator captures your PR URL and number from the branch you push; the `/ship-dag` skill runs the Opus review gate and the dependency-ordered merge separately, so your job ends at "green PR open." Do not merge.
