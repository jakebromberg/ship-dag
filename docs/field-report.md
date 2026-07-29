# Field report — first production run

The first end-to-end production use of ship-dag: one invocation walked a 15-issue dependency DAG across three repositories (a Deno/TypeScript backend with SQL migrations, a SwiftUI iOS app, and a small TypeScript web service) to `main`. This is a case study of what the telemetry captured, what it *couldn't* capture, and the three things the run fed back into the harness itself.

The run's records — anonymized (identifiers remapped to `acme/*`; the records carry no product free-text, so nothing else needed scrubbing) — are committed at [`examples/run-sample.jsonl`](./examples/run-sample.jsonl). Every number below is reproducible **from the repo root** (the `report` command reads whatever file `SHIP_DAG_TELEMETRY` points at, and a missing path yields an empty `records: 0` report rather than an error, so the absolute path matters):

```bash
SHIP_DAG_TELEMETRY="$PWD/docs/examples/run-sample.jsonl" node scripts/telemetry.mjs report
```

## Indicators

```
records:           15
first-pass yield:  8/9 (88.9%)
  mechanical 1/1 (100.0%)
  normal     7/8 (87.5%)
  complex    0/0 (0.0%)
triage-miss proxy: 0/7 (0.0%)
mean bounces:      0.11
review-catch:      0/9 (0.0%)
HITL point-A:      8/15 (53.3%)
HITL point-B:      0/15 (0.0%)
```

15 issues in, 9 merged, 6 stopped at the triage gate (HITL point A) before any implement tokens were spent. Of the 9 that reached implement, 8 merged first-pass and 1 took a single review bounce.

## What the indicators say — and don't

Read these as **direction, not truth**: N is tiny. A few readings are load-bearing, the rest are noise until the sample grows or the offline [eval harness](../references/eval-harness.md) measures them properly.

- **Point A did the heavy lifting (53%).** Triage correctly quarantined both `complex` issues and four design-blocked `normal` issues *before* fan-out. This is the gate working exactly as designed — the cheapest model (Haiku, read-only) paying for itself by not letting Sonnet burn tokens guessing at an unsettled spec. The `complex 0/0` line isn't a failure; it's those two issues never reaching implement.
- **first-pass yield 88.9% is encouraging but unweighted.** Eight of nine specced issues implemented and survived the Opus gate without a bounce. But the denominator is 9, and every one rode the `inline` path (per-stage effort is prompt-*approximated*, not actuated), so treat it as a smoke test that the loop holds together, not a calibrated yield.
- **review-catch 0/9 is the honest trap.** Zero blocking findings can mean the specs were clean *or* the reviewer under-caught — with N=9 and no ground truth, **you cannot tell from telemetry**. This is precisely the circularity the eval harness exists to break: seed a known defect (mutation testing, `eval/`), then measure whether a *blind* reviewer catches it. Do not read 0/9 as "the review stage is redundant."
- **triage-miss 0/7 is real but only after de-noising.** See below.

## Three things the run fed back into the harness

### 1. The documented install silently broke every CLI (P0, fixed)

The skill installs as a symlink (`ln -s ~/Developer/ship-dag ~/.claude/skills/ship-dag`) and SKILL.md drives every script through it (`node "$SD/scripts/plan-waves.mjs" ...`). The entry-point guard was `import.meta.url === \`file://${process.argv[1]}\``. Node canonicalizes `import.meta.url` to the realpath but leaves `process.argv[1]` as the symlink path, so through the symlink the equality is false and `main()` never runs. Invoked the documented way, `plan-waves` emitted an empty spec, `emit-config` an empty config, and `telemetry report` nothing at all — a dead wave loop. Fixed by a symlink-safe `isMain()` helper (`scripts/lib/is-main.mjs`) that realpaths both sides; all nine CLI guards route through it. The bug only surfaced *because* the run went to pull its own telemetry back — a good argument for the harness dogfooding its own report command.

### 2. Telemetry can't distinguish infra-driven escalation from spec-driven

Mid-run, GitHub's PR-creation endpoint had an outage. Two issues logged terminal `error` records with `hitl.pointB` set — not because their specs were ambiguous, but because the *infrastructure* failed; both merged cleanly once the endpoint recovered, each writing a second `merged` record. The raw store therefore held 17 records for 15 issues, and the `report` command's `triage-miss` proxy (which counts a `pointB` after a `clear` triage) would have over-counted those two as triage misses. Deduping the superseded `error` records — keeping one terminal state per issue — drops triage-miss to its true spec-driven value of **0/7**. Lesson: a `pointB` escalation has a *cause* (ambiguous spec vs. failed infra vs. flaky CI) the schema doesn't record, so the triage-miss proxy is only trustworthy on a run with no infra incidents. A `cause` tag on terminal records, or excluding `error`-superseded records from the proxy, would make it robust.

### 3. Auto-merge ran in a degraded mode the harness doesn't document

Remote CI was under an org-wide Actions billing block for the entire run, so every merge rode **local-green** on an unprotected `main` (the local CI profile passed; the remote gate could not run). The green gate held — nothing merged without a passing local suite — but the skill's mental model is "CI pass" meaning *remote* CI. When remote CI is unavailable, auto-merge silently degrades to trusting the local suite plus an unprotected branch. That's a legitimate mode, but it should be an *explicit, logged* one, not an accident of infrastructure — worth a preflight that names which gate is actually authoritative before the merge queue runs.

## Caveats on the sample

- Identifiers are remapped (`acme/api` = the Deno/TS backend, `acme/app` = the iOS app, `acme/web` = the web service); issue and PR numbers are resequenced. Structure — complexity tiers, triage/review verdicts, HITL flags, bounces, final states — is byte-faithful to the real run.
- The two transient outage `error` records are **omitted** from the sample so it models the intended one-terminal-record-per-issue shape; they are discussed in lesson 2 rather than shipped.
- Every record is `path: "inline"`. A run that clears the `--workflow-threshold` and takes the `workflow`/`engine` path would actuate per-stage effort and populate `tokens`, which this sample cannot show.
