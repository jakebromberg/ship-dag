# Telemetry record schema

The one authored description of the records in the run log (`runs.jsonl`, path resolution in `scripts/telemetry.mjs`). `SKILL.md`, the `scripts/telemetry.mjs` header and the README link here instead of restating the field list. The validators are `normalizeRecord` (`scripts/telemetry.mjs`) and `deriveWaveRecords` (`scripts/lib/wave-records.mjs`); `scripts/lib/wave-records.test.mjs` fails when `deriveWaveRecords` emits a key this file does not name in backticks, so add a new key here in the PR that adds it.

Every record carries a `kind` discriminator: `"issue"` (the default; `normalizeRecord` stamps it when absent, so older logs stay valid) or `"retro"`. `append` stamps `ts` when absent.

## Issue record (`kind: "issue"`)

Required (`normalizeRecord` refuses a record without them): `runId`, `repo`, `issue`, `complexity`, `triageStatus`, `path`, `finalState`.

| Key | Value |
| --- | --- |
| `kind` | `"issue"`. |
| `ts` | ISO timestamp, stamped by `append` when absent; `ingest-wave` uses the report's `finishedAt`. |
| `runId` | The run's id (`telemetry.mjs run-id`); a resumed session reuses the original. |
| `reportId` | `ingest-wave` only: the stem of the report the record was derived from. Two PR-less failures are one event only if their `reportId`s match. Hand-written records have none. |
| `ran` | `ingest-wave` only, from a report row that carries it: whether the engine launched a session for the row. Once either record carries it, records of different reports are two events. Absent on older and hand-written records. |
| `repo`, `issue` | `owner/repo` and the issue number. |
| `complexity` | `mechanical`, `normal` or `complex`. |
| `complexitySource` | `entry` (the wave's routing named the complexity) or `default` (it did not; `complexity` is the `normal` ingest assumed). Absent on older records. |
| `triageStatus` | `clear` or `needs-decision`. |
| `assignment` | The model the issue was assigned, or null. |
| `effort`, `effortSource`, `model` | The planned effort, where it came from, and the planned model (null when the wave's routing names none). Derived records only. |
| `path` | `engine`, `inline` or `workflow`. |
| `implStatus` | `pushed`, `blocked`, `error` or null (null for an issue that never reached implement, such as a HITL point A defer or a skip). |
| `ciStatus` | `pass`, `fail`, `none` or null. |
| `reviewVerdict` | `clean`, `blocking`, `nits-only` or null. |
| `reviewPath` | The review file holding the full findings, or null. |
| `failureReason` | An infrastructure stop (`INFRA_REASONS` in `scripts/lib/failure.mjs`: `rate-limited`, `memory-critical`, `lease-wait`, `engine-died`) or null. Never set on a skip. |
| `skipReason` | Absent, null or `"dependency"` (`SKIP_REASON_DEPENDENCY` in `scripts/lib/failure.mjs`), which `deriveWaveRecords` stamps on every `skipped` row: an engine's dependency skip. `append` refuses any other value with `bad skipReason`. An unmarked deferral is a maintainer's. |
| `findings` | Array of the blocking findings of the worst review round (see below). |
| `bounces` | Review rounds that followed a blocking round. |
| `hitl` | `{pointA, pointB}`, booleans. |
| `finalState` | `merged`, `blocked-hitl`, `deferred` or `error`. |
| `pr` | The PR number, or null. Older rows spell it `owner/repo#N` or as a PR URL and are still read; a new record writes the number. |
| `pressureOverride` | `true`, stamped when the user chose point F's "start anyway" for the wave's engine invocation; absent otherwise. |
| `tokens` | Token usage, or null. |
| `cost` | Optional (null reads as absent): `{implement: {costUsd, input, output, cacheRead, cacheCreate, sessions, sessionIds[]}}`, summed from the ref's transcript. A session killed before writing a result is not counted, and a skipped row carries none. |
| `policySource` | `sidecar` (the wave's entry named `blockOn`) or `default`. Derived records only. |
| `tuningVersion` | The tuning version in force. |

### `findings` entries

`findings` is an array. `append` (`normalizeRecord`) accepts two entry shapes:

- a plain string: what a hand-written or `--outcomes` record holds;
- `{category: string|null, verdict: string|null, summary: string}`: what `ingest-wave` derives, one per blocking finding with no cap, `summary` being `<category> <file>:<line> <summary>`.

Anything else is refused with `bad findings`, naming the failing entry's index (or, for a non-array, the value). `readRecords` does not normalize, so log rows written before that check stay readable: those with other object shapes (for instance a non-string `summary`, or a missing `verdict`) are legacy, readable but refused by `append`. Readers accept a mix of strings and objects.

## Retro record (`kind: "retro"`)

One run-scoped record per step-6.5 pass. Required: `runId`, `wave`, `mergedPrs[]`. The rest: `ts`, `proposedRefactors`, `approvedRefactors`, `declinedRefactors`, `proposedAdjustments`, `approvedAdjustments`, `declinedAdjustments`, `filed[]`, `adjusted[]`, `declinedTitles[]`, `tokens`. It is validated separately and excluded from every per-issue indicator.
