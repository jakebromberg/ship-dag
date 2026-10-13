# Field report — the catalog edit/delete parity run

> **Status (2026-10-12):** the P0 finding below, where the review gate scored unknown finding categories as nits, has since been fixed. It was filed as #25, #26, and #27, and PRs #40, #43, and #44 closed them. The fix took a different shape from the proposals below: the category enum gained `convention` and `contract` rather than `test-quality`, the default `--block-on` became `correctness,security,convention,contract`, and a per-finding `blocking` field replaced the proposed `severity`; see `references/review-schema.md`. The report's other findings were filed as #28–#39, which are all still open.

A second production run, and a much larger one: a 13-issue DAG plus epics across four repositories (an Express/Drizzle backend, a Next.js frontend, an OpenAPI contract package, and a Markdown wiki), driven over multiple sessions to 7 merged PRs in the final wave alone. Where the [first field report](./field-report.md) was mostly about the harness's own plumbing, this one is about the **gate**, and about the several ways the loop's assumptions about its environment turned out to be wrong.

The single most important finding is first, because it is a correctness bug in the merge gate rather than an ergonomic one.

## P0 — The gate silently auto-merges whole categories of confirmed defects

`references/review-schema.md` fixes `category` to an enum:

```
correctness | security | simplification | efficiency | test-coverage
```

and says plainly: *"the categories are exactly the schema's `category` enum."* Nothing enforces that. Across six reviewed PRs in the final wave, the Opus reviewers emitted these categories:

| Emitted | In the enum? |
|---|---|
| `correctness`, `simplification`, `efficiency` | yes |
| `test-quality` | **no** — the enum says `test-coverage` |
| `contract` | **no** |
| `completeness` | **no** |
| `convention` | **no** |
| `scope` | **no** |

`review-gate.mjs` reports these in `unknownCategories[]` but **does not let them affect the verdict**. An unknown category is not in `--block-on`, therefore it is not blocking, therefore the PR scores `nits-only` and auto-merges.

What that cost, concretely:

- **wxyc-shared PR #513 had six CONFIRMED findings, every one categorized `contract`.** Under the default `--block-on correctness,security` the gate returns `nits-only` and the PR auto-merges. One of those six was a response field whose published description stated its semantics **backwards** — it declared the field a pure function of one input when the handler folds a second condition in. A contract document that lies about what the server sends is exactly the class of defect this harness exists to stop, and the gate was structurally incapable of stopping it.
- **Backend PR #2625's blocking finding was categorized `test-quality`.** The defect: the spec's parameterization list was a frozen literal, so it generated no case for a table *added* to the constant under test — i.e. the guard could not fail in the direction the ticket existed to guard. Scored as a nit by default.
- **dj-site PR #1604's gate counted 6 blocking only because the operator had widened `--block-on` by hand.** At the default it would have been 4, and the two dropped were `test-quality` findings, one of which was the missing test whose absence *caused* a data-integrity bug elsewhere in the same PR (see P1-c).

### Two fixes, and they are not alternatives

1. **`review-gate.mjs` must fail loudly on an unknown category**, not score it as a nit. The current default is the dangerous direction: unrecognized → not blocking → merge. The same file already treats a missing `findings` array as a hard error on the reasoning that *"a truncated write must never auto-merge"*; an unrecognized category is the same hazard with a quieter failure mode.
2. **The enum needs widening to what reviewers actually produce.** `contract` and `test-quality` are not reviewer sloppiness — they are real, distinct, and load-bearing finding classes that the five-value enum has no home for. `test-coverage` (absent tests) and `test-quality` (present tests that cannot fail) are genuinely different defects and the second was *the dominant finding class of this entire run* (see the pattern note below). Reviewers reached for words the schema didn't offer.

### And a third, subtler one: severity is not modeled

Widening `--block-on` to include `test-quality` was correct for two PRs and wrong for a third: dj-site #1603's finding was a documentary `{}` test case the reviewer itself called a nit, and promoting it to blocking dispatched a fix pass that wasn't warranted. The gate reads `category` only. The reviewer's own blocking/nit judgement is discarded entirely — which is right as the *sole* input (a model must not grade its own homework) but wrong as *no* input. A `severity` field ANDed with the category test would let `test-quality` block real defects without promoting every nit in the category.

## P1 — Three environment assumptions that silently corrupt the run

### a. Machine sleep is the dominant failure mode, and the skill never mentions it

`API Error: Your computer went to sleep mid-response.` killed, in one session: a 47-minute six-session engine run, two review agents, two further reviews, and a fix pass. Six separate agent deaths, all the same cause.

The trap is specific and worth writing down: **`caffeinate -i <command>` lapses the moment that command exits.** Scoping it to the engine invocation leaves every subsequent review, fix pass, and merge exposed — which is exactly when this run lost four agents at once. What works is a bounded, self-expiring hold covering the whole working window:

```sh
nohup caffeinate -i -t 5400 >/dev/null 2>&1 &   # 90 min, self-expires
```

Step 4 should start one before the engine invocation, and the wave loop should renew it per phase. Unbounded `caffeinate` is not the answer either — it outlives the run and silently prevents sleep forever.

### b. Stale primary checkouts make verification confidently wrong

All three primary checkouts were behind `origin/main` (by 16, 5 and 2 commits). The first verification pass in this session read pre-wave code and produced two confident, wrong reports: a symbol declared "absent from `app.yaml`" that was present, and a file called "nonexistent" that existed. Both were retracted only because a second pass happened to fetch first.

This is nastier than an ordinary stale-cache bug because the failure is *silent and confident* — `grep` on an old tree returns a clean empty result, indistinguishable from a true negative. Step 1 should fast-forward every touched repo's primary, or at minimum assert `git rev-parse HEAD == git rev-parse origin/main` before any verification read. The `/cleanup` skill already knows how to do the fast-forward safely (`--ff-only`, refuse on divergence, respect a dirty tree); step 1 should call that logic rather than assume currency.

### c. A missing test is not a lesser finding than the bug it would have caught

dj-site #1604 shipped an inverted cache invalidation: the restore mutation invalidated the one cache a restore cannot change and left stale the two it does, one of which feeds the next-call-number derivation — so the UI could hand out a call number the restore had just re-occupied and file two catalog cards into one physical shelf slot.

The reviewer found that bug *and* found, separately, that the invalidation conditional had no test. Its observation is the one worth promoting into the skill: **writing the missing test would have forced the author to enumerate which caches a restore makes stale, which is the step that was skipped.** A `test-quality` finding on a conditional adjacent to a `correctness` finding is not two findings; it is the same finding twice, and the cheap one is upstream of the expensive one.

## P1 — The merge queue is under-specified for multi-repo runs

Three distinct problems, all hit in one wave.

### a. Bare `gh pr merge <n>` resolves against cwd

The skill's merge queue is explicitly cross-repo, and the skill already mandates fully-qualified `owner/repo#N` refs when handing work to `/review-loop` *for exactly this reason*. It does not carry that discipline into step 6. A five-command merge list run from the wrong directory sent every command at one repo. Four failed loudly — but **one silently hit a different, already-merged PR that happened to share the number**, reporting `already merged` in a way that reads like success. In a four-repo run, PR numbers collide constantly.

Step 6 must emit `--repo owner/repo` on every command. This is a one-line fix to the skill and it prevents a class of error whose failure mode is a *reassuring* message.

### b. `required_status_checks.strict: true` is not modeled

One repo in this run required branches to be current with `main`. Consequences the skill doesn't mention:

- Each merge invalidates every remaining branch; merging N PRs costs N−1 `gh pr update-branch` calls and N−1 extra CI runs.
- `gh pr merge --admin` **bypasses the up-to-date requirement too**, so admin-merging into a strict repo merges a branch that was never tested against current `main`. That is a legitimate mode but it should be a named, logged one — the same lesson the first field report drew about local-green auto-merge.
- `update-branch` immediately followed by `merge` races GitHub's mergeability recomputation and returns `GraphQL: Pull Request is not mergeable` for a PR that is merely still being computed. The queue needs to poll `mergeable != UNKNOWN`, not trust the first answer.

### c. "Land the seam before the feature" belongs in step 6, not only in PR-splitting guidance

Two Backend PRs both touched one service file: a refactor exporting a shared fold, and a feature adding a second caller of it. Merge order was load-bearing beyond conflict convenience — the refactor's author had *deliberately declined* to extract a JS helper on the grounds that the expression was spelled only once, and the feature PR is precisely what made it twice. Merging the seam first kept that reasoning coherent and made the follow-up fix obvious; the reverse order would have produced a third hand-copied spelling.

The skill's PR-size guidance already says "land the seam before the feature." Step 6's ordering rule should cite it, and should order same-file PRs seam-first rather than by issue number.

## P2 — The retrospective's own proposals get no premise-check

Step 3 has a good discipline: triage's questions are premise-checked by a Sonnet pass against real code *before* a human is grilled, on the stated grounds that Haiku's questions "routinely rest on claims about the code that are simply false."

Step 6.5's proposals get no such pass, and in this run two of five rested on false premises:

- One asserted "a grep for `"code" in` and `data as { code` returns nothing." Too narrow — it missed `data.code`, and the repo already contained a complete private implementation of the very reader the proposal wanted written. The estimate moved from ~15 lines to ~50–70 once checked.
- One was filed under the wrong parent because no predecessor search had run. The actual predecessor contained a near-verbatim version of the same check, differing in one load-bearing detail (it compared against the *installed* package rather than the source), which the proposal would have silently contradicted.

Both were caught only because the operator verified before filing. The step-3 premise-check should be a step-6.5 step too — it is the same failure mode at a later stage, and the cost of a wrong retro ticket is higher because it arrives with the authority of a "lesson learned."

## P2 — Reviewer citations are hints, not coordinates

Three separate instances in one wave of a reviewer citing a location or count wrongly while its *substance* was correct:

- `types.ts:470-471` was actually `437-438`.
- "`merge.ts` restates the fold in **four** raw-SQL sites" — there were four raw-SQL sites **plus a module docblock**, five expressions. The operator repeated the undercount twice before a fix-pass agent recounted.
- "three dead sub-assertions **of this shape**" — two were of that shape; the third was a different defect (pinning a prose pointer to a property the schema lacks).

None of these invalidated a finding, and all three would have wasted an implementer's time. Fix-pass briefs should instruct agents to **re-locate by symbol or content, treating cited line numbers as approximate**, and to report the correction. All three of this run's fix-pass agents did exactly that unprompted, which suggests the instruction is cheap to add and reliably followed.

Related: a fix brief must cite only files that exist **on the branch being fixed**. One brief in this run told an agent that a particular unit suite would pin its refactor; that suite arrives with a *different, still-open* PR and was not on the branch. The agent caught it and substituted a real-Postgres integration run, but the brief's claim was simply false.

## P3 — Three smaller gaps

**Repos with no CI make the review gate the only gate.** The wiki PR had `checks: []` and `mergeStateStatus: CLEAN` — nothing mechanical verified it at all. It was a convention document, and the Opus review found three garbled worked examples, including one describing the *fixed* form of a test as the broken one. A convention doc teaching the inverse of its lesson is a durable hazard. The skill should note that for no-CI repos, `--max-review-iter` and a human confirmation read matter *more*, not less, and that `CLEAN` there means "nothing objected," not "verified."

**Auto-deploying repos need merge spacing.** Two merges four seconds apart triggered two `Auto Build & Deploy` runs in a repo that deploys on push to `main`; one was cancelled and one left queued, and the deploy that actually mattered was a third run on a later commit from an unrelated workstream. Step 6 should either space merges in auto-deploying repos or state explicitly that only the final merge's deploy needs watching — and watch it, because an auto-merge that lands green code behind a failed deploy is a silent partial success.

**`telemetry.mjs` has no `--help`.** `node scripts/telemetry.mjs append --help` crashes with `SyntaxError: No number after minus sign in JSON` — it `JSON.parse`s `argv[2]` unconditionally. The dispatcher prints `usage: telemetry.mjs <append|report> ...` for a bad subcommand but nothing documents `append`'s payload. Minor, but the first field report's own lesson was that the harness benefits from dogfooding its CLIs.

## The finding pattern worth carrying forward

Across six reviewed PRs and 35 findings in the final wave, **not one finding was in an implementation's logic.** Every single one was in what a test or a docblock *claimed*:

1. A parameterization list frozen so the guard couldn't fail in the direction it existed for.
2. A JS-to-JS equality named as the cross-boundary check that tied two representations together.
3. An `expect(...).not.toMatch(...)` that no realistic regression could trip, with a comment asserting it pinned the wording.
4. Five `expect(mock).not.toHaveBeenCalled()` guards that a refactor silently turned vacuous — the call they forbade simply stopped happening.
5. A worked example in a conventions document describing the fixed form of a test as the broken one.

The harness's implement stage is producing code that works. Its documentary and test-assertion layers are where the defects live, and the default gate is blind to precisely that (P0). Those two facts are the same fact.

One encouraging note: the convention document that promotes tamper-verification — make the change the test defends, confirm red, revert — merged in this same wave, so the response to this pattern is now a live standing reference rather than a proposal. Every fix-pass agent in the wave tamper-verified unprompted and reported red counts per tamper, and that is what caught items 1 and 4 above.

## What the indicators say now (9 retro passes, 72 issue records)

```
records:           72
quota failures:    3
first-pass yield:  20/66 (30.3%)
  mechanical 5/9 (55.6%)   normal 14/47 (29.8%)   complex 1/10 (10.0%)
triage-miss proxy: 31/63 (49.2%)
review-catch:      28/66 (42.4%)
HITL point-A:      12/72 (16.7%)
HITL point-B:      16/72 (22.2%)
retro passes:      9 (34 PRs) — 62 proposed, 55 approved, 2 declined (96.5%)
```

Three readings, one of which is a warning about the instrument rather than the loop.

**`review-catch` moved from 0/9 to 28/66 (42.4%), and that retires the first report's open question.** That report called `0/9` "the honest trap" — zero blocking findings could mean clean specs *or* an under-catching reviewer, and telemetry couldn't tell you which. At N=66 the reviewer is blocking 42% of PRs that reach it, with the findings in this wave independently verified against source. The review stage is not redundant. Note the tension with P0 above, though: that 42% is measured against whatever `--block-on` each wave used, and the unknown-category bug means the *true* catch rate is higher than the recorded one — findings that should have blocked were counted as nits.

**`triage-miss proxy: 49.2%` is measuring the harness's environment, not its triage.** The first report identified this: a `pointB` escalation has a cause the schema doesn't record, so the proxy is only trustworthy on a run with no infra incidents. This run had six agent deaths from machine sleep and three quota failures. Nearly half of the "triage misses" are almost certainly sleep and rate-limit deaths on issues whose specs were fine. The recommendation from the first report — a `cause` tag on terminal records — is now not a nicety; it is the difference between a headline indicator that means something and one that silently tracks how often the laptop slept. `failureReason` already exists and already carries `"rate-limited"`; extending it to `"sleep"` / `"infra"` and excluding those from the proxy is a small change to a script that already has the field.

**`retro approvalRate 96.5%` (55 of 57 decided) is the number to be suspicious of.** Across nine passes, only two proposals were ever declined — and one of those is this pass's. A gate that approves 96% of what it is shown is either being fed very good proposals or is not discriminating. Given P2 above — that two of five proposals in one pass rested on false premises and were only corrected because the operator checked — the more likely reading is that the human at point D is approving on the proposal's *plausibility* rather than its verified premise. That is precisely the argument for extending the step-3 premise-check to step 6.5: not to reject more proposals, but to make the approvals mean something.

**`first-pass yield` fell from 88.9% (N=9) to 30.3% (N=66)** and should not be read as regression. The first run's nine issues all rode the inline path on a single small DAG; these 66 span multi-repo waves with real CI, a stricter review gate, and the infra losses above in the denominator. The `complex 1/10` line is the one to watch as N grows — if complex issues keep yielding ~10% first-pass, the honest response is to stop routing them through implement at all and split them at triage instead, which is what the point-A oversize fork already does for size and does not yet do for complexity.
