// wave-records.mjs — turn the engine's own on-disk artifacts into telemetry
// records, so a wave's records are a *consequence* of the wave running rather
// than five prose reminders the main agent has to remember under context
// pressure.
//
// The defect this exists to fix is chronic under-emission: SKILL.md specified
// emission at five points, every one of them an instruction to the model, and
// they degraded exactly when a run was long and multi-wave — the runs whose
// data matters most. The structural half of the fix is here: everything the
// engine already wrote down is *derived*, never re-typed.
//
// Two artifacts, both already on disk after any engine wave:
//   <stateDir>/config.json            the config emit-config.mjs wrote
//   <stateDir>/ship-dag-wave.json     the sidecar emit-config.mjs writes (triage facts)
//   <stateDir>/state/reports/<ISO>.json  the per-wave report the engine wrote
// The report carries one row per issue — `ref`, `status`, `prUrl`, `prNumber`.
// The config/sidecar carries the triage half — `complexity`, the model each
// issue was assigned, and the run's identity.
//
// What is derived (cannot be forgotten, cannot be mistyped):
//   runId, repo, issue, complexity, triageStatus, assignment, path,
//   implStatus, ciStatus, pr, ts
// What is *not* derivable and must be supplied per issue (genuine agent
// judgements no file on disk records — see SKILL.md's Telemetry section):
//   finalState, reviewVerdict, findings[], bounces, hitl, failureReason, tokens
// A missing outcome is **named and refused**, never defaulted — the whole point
// is that a half-reported wave fails loudly instead of silently shrinking.
//
// Pure: no I/O, no globals, no clock beyond an injected `now`. Matches
// scripts/lib/stats.mjs and scripts/lib/rate-limit.mjs.

/** The complexity tier assumed when neither config nor sidecar recorded one. */
const DEFAULT_COMPLEXITY = 'normal';

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * Mint a run identifier: `sd-<YYYYMMDD>-<HHMMSS>` in **local** time (matching
 * the hand-minted ids already in the log), plus an optional slugged label.
 * Minting in a script rather than in the agent's head is what makes per-run
 * grouping survive a compaction: the id is a value the shell exports once
 * (`SHIP_DAG_RUN_ID`) instead of a string the model has to keep re-inventing.
 * @param {{now?: Date, label?: string}} [opts]
 * @returns {string}
 */
export function mintRunId({ now = new Date(), label } = {}) {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug ? `sd-${stamp}-${slug}` : `sd-${stamp}`;
}

/**
 * Recover the runId from an engine config `name` (`ship-dag-<runId>`, per
 * SKILL.md step 4a). A name that doesn't carry the prefix is returned as-is,
 * so a hand-written config still yields *something* groupable.
 * @param {string|undefined|null} name
 * @returns {string|null}
 */
export function runIdFromConfigName(name) {
  if (typeof name !== 'string' || !name) return null;
  return name.startsWith('ship-dag-') ? name.slice('ship-dag-'.length) : name;
}

/**
 * Fold a runId to the form two spellings of the same run share, for *matching
 * only* — never for what a record stores. Real logs and real state dirs drift
 * two ways that both mean the same run: an extra `ship-dag-` prefix (the
 * config `name` is `ship-dag-<runId>`, and a runId that already began with it
 * got the prefix twice or not at all), and a per-wave suffix on the state dir
 * (`-w2`, `-w1b`, `-r2`, `-resume`) that the log's runId does not carry.
 * `audit` folds both sides so it reports the waves that genuinely never
 * reached the log, rather than crying wolf on every wave of every run.
 * @param {string|null|undefined} runId
 * @returns {string|null}
 */
export function canonicalRunId(runId) {
  if (typeof runId !== 'string' || !runId.trim()) return null;
  let out = runId.trim().toLowerCase();
  while (out.startsWith('ship-dag-')) out = out.slice('ship-dag-'.length);
  let prev;
  do {
    prev = out;
    out = out.replace(/-(?:wave|resume|w|r)\d*[a-z]?$/, '');
  } while (out !== prev && out);
  return out || runId.trim().toLowerCase();
}

/**
 * Split a composite ref (`owner/repo#N`) into its parts. Null for anything
 * that isn't one — a bare `N` carries no repo, and telemetry records are
 * keyed on `repo` + `issue`, so guessing would silently merge two repos'
 * issues under one identity.
 * @param {string|undefined|null} ref
 * @returns {{repo: string, issue: number}|null}
 */
export function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(ref.trim());
  return m ? { repo: m[1], issue: Number(m[2]) } : null;
}

/** The composite ref for a config/sidecar issue entry, using `fallbackRepo` when it carries none. */
function refOf(issue, fallbackRepo) {
  if (issue.ref) return issue.ref;
  const repo = issue.repo || fallbackRepo;
  return repo && issue.number != null ? `${repo}#${issue.number}` : null;
}

/**
 * Accept the three outcome shapes the main agent may write, and return a
 * `Map<ref, outcome>`. The terser shapes exist deliberately: the cheaper the
 * emission call is to author, the less likely it is to be skipped.
 *   - array:     `[{ ref, finalState, ... }, ...]`
 *   - object:    `{ "owner/repo#1": { finalState, ... } }`
 *   - shorthand: `{ "owner/repo#1": "merged" }`
 * @param {Array<object>|Record<string, object|string>|undefined|null} outcomes
 * @returns {Map<string, object>}
 */
export function normalizeOutcomes(outcomes) {
  const out = new Map();
  if (!outcomes) return out;
  const put = (ref, value) => {
    if (!ref) return;
    out.set(ref, typeof value === 'string' ? { finalState: value } : { ...value });
  };
  if (Array.isArray(outcomes)) {
    for (const o of outcomes) {
      if (!o || typeof o !== 'object') continue;
      const { ref, ...rest } = o;
      put(ref || refOf(o, o.repo), rest);
    }
    return out;
  }
  if (typeof outcomes === 'object') {
    for (const [ref, value] of Object.entries(outcomes)) put(ref, value);
  }
  return out;
}

/** The engine `status` → the telemetry `implStatus` the record carries. */
function implStatusOf(status) {
  if (status === 'succeeded') return 'pushed';
  if (status === 'blocked') return 'blocked';
  return 'error';
}

/**
 * The engine `status` + whether a PR exists → `ciStatus`. A `succeeded` row
 * means the engine ran that repo's CI green *before* opening the PR (SKILL.md
 * step 4c), so it is unambiguously a pass. A non-succeeded row that still has
 * a PR got as far as CI and went red; one with no PR never reached CI at all.
 */
function ciStatusOf(status, pr) {
  if (status === 'succeeded') return 'pass';
  return pr == null ? null : 'fail';
}

/** Index a config's (or sidecar's) issues by composite ref. */
function indexConfigIssues(config) {
  const byRef = new Map();
  if (!config || !Array.isArray(config.issues)) return byRef;
  const fallbackRepo = config.defaultRepo || config.repo;
  for (const issue of config.issues) {
    const ref = refOf(issue, fallbackRepo);
    if (ref) byRef.set(ref, issue);
  }
  return byRef;
}

/**
 * Derive one telemetry issue record per row of an engine wave report, joining
 * the report against the config/sidecar that produced it and the outcomes the
 * main agent supplies for the judgement half.
 *
 * @param {object} args
 * @param {object} args.report      the parsed `<stateDir>/state/reports/<ISO>.json`
 * @param {object|null} [args.config]  the parsed `config.json` or `ship-dag-wave.json`
 * @param {string} [args.runId]     explicit override (else sidecar/config name, else report configName)
 * @param {Array|object} [args.outcomes]  see normalizeOutcomes
 * @param {string} [args.path]      the SKILL.md path label (`engine` here by construction)
 * @returns {{records: object[], missing: string[], unknown: string[]}}
 *   `missing` — report rows with no outcome supplied; no record is produced for
 *   them, and the caller is expected to refuse rather than write a partial wave.
 *   `unknown` — outcomes naming a ref the report never mentions (a typo, or an
 *   outcome for the wrong wave).
 */
export function deriveWaveRecords({ report, config = null, runId, outcomes, path = 'engine' } = {}) {
  const rows = Array.isArray(report?.issues) ? report.issues : [];
  const byRef = indexConfigIssues(config);
  const supplied = normalizeOutcomes(outcomes);
  const resolvedRunId = runId
    || config?.runId
    || runIdFromConfigName(config?.name)
    || runIdFromConfigName(report?.configName);
  // The engine's own clock, not the ingest clock: a wave ingested (or
  // backfilled) hours later must land at the time the work actually happened,
  // or `report --since` silently reattributes it to the wrong day.
  const waveTs = report?.finishedAt || report?.startedAt || undefined;
  const fallbackRepo = config?.defaultRepo || config?.repo;

  const records = [];
  const missing = [];
  const seen = new Set();
  for (const row of rows) {
    const parsed = parseRef(row.ref);
    const cfgRef = row.ref || (fallbackRepo && row.number != null ? `${fallbackRepo}#${row.number}` : null);
    const cfg = (cfgRef && byRef.get(cfgRef)) || null;
    const repo = parsed?.repo || cfg?.repo || fallbackRepo || null;
    const issue = parsed?.issue ?? row.number ?? null;
    const ref = cfgRef || (repo && issue != null ? `${repo}#${issue}` : null);
    if (ref) seen.add(ref);
    const outcome = (ref && supplied.get(ref)) || null;
    if (!outcome || !outcome.finalState) {
      missing.push(ref ?? String(row.number ?? '(unidentifiable row)'));
      continue;
    }
    const pr = row.prNumber ?? null;
    const hitl = outcome.hitl || {};
    records.push({
      runId: resolvedRunId,
      repo,
      issue,
      complexity: cfg?.complexity || DEFAULT_COMPLEXITY,
      triageStatus: 'clear', // only cleared issues reach an engine config (SKILL.md step 3)
      assignment: cfg?.assignment ?? cfg?.model ?? config?.defaultModel ?? null,
      path,
      implStatus: implStatusOf(row.status),
      ciStatus: ciStatusOf(row.status, pr),
      reviewVerdict: outcome.reviewVerdict ?? null,
      failureReason: outcome.failureReason ?? null,
      findings: outcome.findings ?? [],
      bounces: outcome.bounces ?? 0,
      hitl: { pointA: !!hitl.pointA, pointB: !!hitl.pointB },
      finalState: outcome.finalState,
      pr: outcome.pr ?? pr,
      tokens: outcome.tokens ?? null,
      ts: outcome.ts || waveTs,
    });
  }
  const unknown = [...supplied.keys()].filter((ref) => !seen.has(ref));
  return { records, missing, unknown };
}

/**
 * One HITL point-A record per issue the triage gate deferred. Derived from the
 * ready-wave spec the emitter already reads, so the step-3 deferrals are
 * written by the same command that builds the engine config instead of by a
 * separate remembered step.
 * @param {{runId: string, repo?: string, deferred?: Array<object>, path?: string}} spec
 * @returns {object[]}
 */
export function deferredRecords({ runId, repo: defaultRepo, deferred, path = 'engine' } = {}) {
  const out = [];
  for (const entry of deferred ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const parsed = parseRef(entry.ref);
    const repo = parsed?.repo || entry.repo || defaultRepo || null;
    const issue = parsed?.issue ?? entry.number ?? null;
    if (repo == null || issue == null) continue;
    out.push({
      runId,
      repo,
      issue,
      complexity: entry.complexity || DEFAULT_COMPLEXITY,
      triageStatus: 'needs-decision',
      assignment: null,
      path,
      implStatus: null,
      ciStatus: null,
      reviewVerdict: null,
      findings: [],
      bounces: 0,
      hitl: { pointA: true, pointB: false },
      finalState: 'blocked-hitl',
      pr: null,
      tokens: null,
    });
  }
  return out;
}

/**
 * The `ship-dag-wave.json` sidecar emit-config.mjs drops beside the engine
 * config. It records the half of the wave the engine's own report cannot: the
 * run identity, the wave number, each issue's triage complexity and assigned
 * model, and the refs deferred at point A. `ingest-wave` prefers it over
 * `config.json` because it is the only place the wave number survives.
 * @param {object} spec  the ready-wave spec emit-config.mjs was handed
 * @param {{now?: () => string}} [opts]
 */
export function waveSidecar(spec, { now = () => new Date().toISOString() } = {}) {
  const fallbackRepo = spec.repo;
  return {
    runId: spec.runId || runIdFromConfigName(spec.name),
    wave: spec.wave ?? null,
    path: 'engine',
    emittedAt: now(),
    issues: (spec.issues ?? []).map((issue) => ({
      ref: refOf(issue, fallbackRepo),
      repo: issue.repo || fallbackRepo || null,
      number: issue.number,
      complexity: issue.complexity || null,
      assignment: issue.model || null,
    })),
    deferred: (spec.deferred ?? [])
      .map((entry) => refOf(entry, fallbackRepo))
      .filter(Boolean),
  };
}
