# Telemetry record schema

The one authored description of the records in the run log (`runs.jsonl`, path resolution in `scripts/telemetry.mjs`). `SKILL.md`, the `scripts/telemetry.mjs` header and the README link here instead of restating the field list. The validators are `normalizeRecord` (`scripts/telemetry.mjs`) and `deriveWaveRecords` (`scripts/lib/wave-records.mjs`); `scripts/telemetry.test.mjs` fails when a record `ingest-wave` appends carries a key that the first cell of no row of the issue-record table below names in backticks (a mention elsewhere in this file does not count), so add a new key's row in the PR that adds it.

Every record carries a `kind` discriminator: `"issue"` (the default; `normalizeRecord` stamps it when absent, so older logs stay valid) or `"retro"`. `append` stamps `ts` when absent.

## Issue record (`kind: "issue"`)

Required (`normalizeRecord` refuses a record without them): `runId`, `repo`, `issue`, `complexity`, `triageStatus`, `path`, `finalState`.

| Key | Value |
| --- | --- |
| `kind` | `"issue"`. |
| `ts` | ISO timestamp, stamped by `append` when absent; `ingest-wave` uses the report's `finishedAt`, else its `startedAt`, except on a death record derived from an `engineDeaths` marker, which is dated by the marker's `at`. |
| `runId` | The run's id (`telemetry.mjs run-id`); a resumed session reuses the original. |
| `reportId` | `ingest-wave` only: the stem of the report the record was derived from. Two PR-less failures (`implStatus` `error` or `blocked`, the rows a retry re-runs) are one event only if their `reportId`s match (two `blocked` ones are one event regardless), while any other record a later report re-lists unchanged stays one. Hand-written records have none. |
| `ran` | `ingest-wave` only, from a report row that carries it: whether the engine launched a session for the row. Once either record carries it, records of different reports are two events, since a row a later report only carries over (`ran: false`, listed by an earlier report of the run family with the same status and PR) derives no record. Absent on older and hand-written records. |
| `repo`, `issue` | `owner/repo` and the issue number. |
| `complexity` | `mechanical`, `normal` or `complex`. |
| `complexitySource` | `entry` (the wave's routing named the complexity) or `default` (it did not; `complexity` is the `normal` ingest assumed). Absent on older records. |
| `triageStatus` | `clear` or `needs-decision`. |
| `assignment` | The model the issue was assigned, or null. |
| `effort`, `effortSource`, `model` | The planned effort, where it came from, and the planned model (null when the wave's routing names none). Derived records only. |
| `path` | `engine`, `inline` or `workflow`. |
| `implStatus` | `pushed`, `blocked`, `error` or null (null for an issue that never reached implement: a HITL point A defer, a skip, or an engine launch stop such as `lease-wait`). |
| `ciStatus` | `pass`, `fail`, `none` or null (null for an issue that never reached implement). |
| `reviewVerdict` | `clean`, `blocking`, `nits-only` or null (null for an issue that never reached implement). |
| `reviewPath` | The review file holding the full findings, or null. |
| `failureReason` | An infrastructure stop (`INFRA_REASONS` in `scripts/lib/failure.mjs`: `rate-limited`, `memory-critical`, `lease-wait`, `engine-died`) or null, so the eval harness can separate infrastructure failures from model failures. `rate-limited` comes with `implStatus: "error"` when the rate-limit wrapper (`scripts/rate-limit-preflight.mjs`, `scripts/lib/rate-limit.mjs`) finds the five-hour window was the cause; `engine-died` (the engine process died: a row its rebuilt report stamps, or each `engineDeaths: [{at}]` marker on a report row, claude-orchestrator#315) comes with `implStatus: "error"`, and a marker's death record has `finalState: "deferred"`, `findings: []` and no `skipReason`, ahead of the row's own record as its continuation; a marker is an earlier death than its report's own, recorded once by its `at`, and is the death of the run its restart followed: the same config's latest report to start (`startedAt`) before it, if that report started after the marker before it. When that report's row is stamped `engine-died`, the marker records nothing: the death is that report's own record (or, for a row ingested before #286, its model-error record with that report's `reportId`: no other model error), with its `reportId` and the dead run's session cost, so a death is recorded once, by the same record, whichever report is ingested first, and `audit` names that report's row until it is ingested. A marker death already appended for a stamped report before this rule holds that report's own record. A hand rebuild keeps the dead run's own `startedAt`. A relaunch that died without writing a report is no report: a marker that lists its death but not the one before it is taken for the earlier report's (a known limit); and a launch stop that never started (`memory-critical`, `lease-wait`) with null. `report()` tallies them in `resourceStops`. Never set on a skip. |
| `skipReason` | Absent, null or `"dependency"` (`SKIP_REASON_DEPENDENCY` in `scripts/lib/failure.mjs`), which `deriveWaveRecords` stamps on every `skipped` row: an engine's dependency skip. `append` refuses any other value with `bad skipReason`. An unmarked deferral is a maintainer's. |
| `findings` | Array of the blocking findings of the worst review round (see below). `append` reads an absent or null `findings` as `[]`. |
| `bounces` | Review rounds that followed a blocking round. |
| `hitl` | `{pointA, pointB}`, booleans. |
| `finalState` | `merged`, `blocked-hitl`, `deferred` or `error`. |
| `pr` | The PR number, or null. Older rows spell it `owner/repo#N` or as a PR URL and are still read; a new record writes the number. |
| `pressureOverride` | `true`, stamped when the user chose point F's "start anyway" for the wave's engine invocation; absent otherwise. |
| `tokens` | Token usage, or null. |
| `cost` | Optional (null reads as absent): `{implement: {costUsd, input, output, cacheRead, cacheCreate, sessions, sessionIds[]}}`, summed from the ref's transcript over the sessions that wrote a result record and that no earlier record of the ref's run family (`sameRun`) lists, so a session is counted once across the family. A session killed before writing a result (a stall, a hard death) is not counted, so the figure can fall short of the real spend. A skipped row carries none. |
| `policySource` | `sidecar` (the wave's entry named `blockOn`) or `default`. Derived records only. |
| `tuningVersion` | The tuning version in force. |

### `findings` entries

`findings` is an array. `append` (`normalizeRecord`) accepts two entry shapes:

- a plain string: what a hand-written or `--outcomes` record holds;
- `{category: string|null, verdict: string|null, summary: string}`: what `ingest-wave` derives, one per blocking finding with no cap, `summary` being `<category> <file>:<line> <summary>` (`(blank)` for a null category; `<file>` alone when the line is null, and no location when there is no file).

Anything else is refused with `bad findings`, naming the failing entry's index (or, for a non-array, the value). `readRecords` does not normalize, so log rows written before that check stay readable: those with other object shapes (for instance a non-string `summary`, or a missing `verdict`) are legacy, readable but refused by `append`. Readers accept a mix of strings and objects. The one rule for the object shape is `isFindingObject` in `scripts/lib/finding.mjs`: `append` and `report()` both use it. `report()` counts a legacy object by no category: only an `isFindingObject` entry feeds `findingCategories`, and a blocking row with none (strings, legacy objects, or no `findings` key at all) counts under `unstructured`.

## Retro record (`kind: "retro"`)

One run-scoped record per step-6.5 pass. Required: `runId`, `wave`, `mergedPrs[]`. The rest: `ts`, `proposedRefactors`, `approvedRefactors`, `declinedRefactors`, `proposedAdjustments`, `approvedAdjustments`, `declinedAdjustments`, `filed[]`, `adjusted[]`, `declinedTitles[]`, `tokens`. It is validated separately and excluded from every per-issue indicator. Older retro rows carry legacy keys (`refactorsProposed`, `adjustmentsProposed`, `proposedPlanAdjustments`, `approvedAll`) from before the canonical counts, whose canonical counts `normalizeRetroRecord` zero-filled; `readRecords` still reads them, and T-retro-approval (`LEGACY_RETRO` in `scripts/lib/tripwires.mjs`) drops them from its sample.
