#!/usr/bin/env node
// resource-preflight.mjs — SKILL.md step 4's memory-pressure preflight, run
// beside rate-limit-preflight.mjs before every engine invocation, and before each
// step 4d/5 review/fix hand-off, which reads `recommendedHandoff`. Step 6.2's
// CI re-run uses it too, via run-ci-profile.mjs's exit 75 and the 15-minute bound.
// See point F's per-step table in references/escalation-policy.md for what each
// guarded step asks the human.
//
// Reads the pressure level and lease status from claude-orchestrator's
// `$CO_HOME/dist` (`defaultLeaseOptions` + `leaseStatus`) and prints the
// decision scripts/lib/resource.mjs makes from it. The lease API is
// parameter-injected so tests never read the real sysctl or lease directory.
// It strips CO_PRESSURE_OVERRIDE from the env it hands the factory, so it
// reports the real level even inside an overridden invocation. Like the
// rate-limit preflight it fails open: a CO_HOME whose dist lacks the exports,
// fails to import or throws while sampling proceeds with the requested K and
// `reason: "lease-unavailable"`.
//
// Usage:
//   node resource-preflight.mjs check [--parallel K] [--waited-minutes N]
//                                     [--wait-max-minutes 15] [--sleep-before S]
// Prints `{ action, reason, level, capacity, step, sessions, live, recommendedParallel, recommendedHandoff }` as
// JSON on stdout (`action`: "proceed" | "wait" | "hitl") and a one-line human
// summary on stderr. `step` is the machine-wide headroom step (0–4) and
// `sessions` the implementer pool's `{ capacity, live }` at that step; a dist
// whose `leaseStatus` predates them (claude-orchestrator before #168/#172)
// leaves both out, as does the `lease-unavailable` result. `--sleep-before` waits before sampling, so SKILL.md's
// loop never needs a foreground `sleep`. `--waited-minutes` is the total
// waited before this call; the call adds its own `--sleep-before` to it
// before deciding. Exit codes: 2 = usage error (unknown subcommand, malformed flag).

import { setTimeout as delay } from 'node:timers/promises';
import { importCo } from './lib/co-home.mjs';
import { parseNumberOption } from './lib/cli-args.mjs';
import { isMain } from './lib/is-main.mjs';
import { DEFAULT_PARALLEL, DEFAULT_WAIT_MAX_MINUTES, handoffLimit, resourceDecision } from './lib/resource.mjs';

/** Import `leaseStatus` and `defaultLeaseOptions` from the engine checkout's dist; throws if either is missing. */
async function importLease(env) {
  const mod = await importCo(env, ['leaseStatus', 'defaultLeaseOptions']);
  return { leaseOptionsFor: mod.defaultLeaseOptions, leaseStatus: mod.leaseStatus };
}

/**
 * Sample the machine and decide. Never throws: any failure to reach the lease API is `lease-unavailable`.
 * @param {{parallel?: number, waitedMinutes?: number, waitMaxMinutes?: number, sleepBefore?: number}} opts
 * @param {{env?: object, leaseOptionsFor?: Function, leaseStatus?: Function, sleep?: (ms: number) => Promise<void>}} [io]
 */
export async function checkResource(opts, { env = process.env, leaseOptionsFor, leaseStatus, sleep = delay } = {}) {
  const parallel = opts.parallel ?? DEFAULT_PARALLEL;
  try {
    if (!leaseOptionsFor || !leaseStatus) ({ leaseOptionsFor, leaseStatus } = await importLease(env));
    if (opts.sleepBefore > 0) await sleep(opts.sleepBefore * 1000);
    const { CO_PRESSURE_OVERRIDE: _stripped, ...realEnv } = env;
    const { level, capacity, step, live, sessions } = leaseStatus(leaseOptionsFor(realEnv));
    // --waited-minutes is the total waited before this call; this call's own sleep counts toward the cap.
    const waitedMinutes = (opts.waitedMinutes ?? 0) + (opts.sleepBefore > 0 ? opts.sleepBefore / 60 : 0);
    const decision = resourceDecision({ level, parallel, waitedMinutes, waitMaxMinutes: opts.waitMaxMinutes });
    // An older dist's leaseStatus has no `step` or `sessions`: leave them out rather than print undefined.
    const pool = { ...(step === undefined ? {} : { step }), ...(sessions === undefined ? {} : { sessions }) };
    return { ...decision, level, capacity, ...pool, live, recommendedHandoff: handoffLimit({ reason: decision.reason, capacity, live }) };
  } catch (err) {
    return { action: 'proceed', reason: 'lease-unavailable', detail: err.message, level: null, capacity: null, live: [], recommendedParallel: parallel, recommendedHandoff: 1 };
  }
}

/**
 * Parse the `check` flags; throws naming the bad flag on a malformed or out-of-range value.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = { parallel: undefined, waitedMinutes: 0, waitMaxMinutes: DEFAULT_WAIT_MAX_MINUTES, sleepBefore: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--parallel') {
      opts.parallel = parseNumberOption('parallel', argv[++i], { min: 1 });
      if (!Number.isInteger(opts.parallel)) throw new Error(`--parallel must be an integer >= 1, got: ${opts.parallel}`);
    }
    else if (a === '--waited-minutes') opts.waitedMinutes = parseNumberOption('waited-minutes', argv[++i], { min: 0 });
    else if (a === '--wait-max-minutes') opts.waitMaxMinutes = parseNumberOption('wait-max-minutes', argv[++i], { exclusiveMin: 0 });
    else if (a === '--sleep-before') opts.sleepBefore = parseNumberOption('sleep-before', argv[++i], { min: 0 });
  }
  return opts;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'check') {
    process.stderr.write('usage: resource-preflight.mjs check [--parallel K] [--waited-minutes N] [--wait-max-minutes 15] [--sleep-before S]\n');
    process.exit(2);
  }
  let opts;
  try {
    opts = parseArgs(rest);
  } catch (err) {
    process.stderr.write(`resource-preflight: ${err.message}\n`);
    process.exit(2);
  }
  const out = await checkResource(opts);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.stderr.write(`resource-preflight: ${out.reason} (pressure ${out.level ?? 'unread'}) — ${out.action}\n`);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
