// host-dispatch.mjs — the pure rules of SKILL.md's dual-host dispatch (step 4b): where a remote script's exit code
// routes, which hosts a per-host resource preflight lets launch, and what the shared rate-limit preflight decides.
// Nothing here touches a host.
import { EXIT } from './remote.mjs';

const ROUTES = {
  'host-sync-claude': { [EXIT.ok]: 'host-prepare' },
  'host-prepare': { [EXIT.ok]: 'host-run' },
  'host-run': { [EXIT.ok]: 'read-reports', [EXIT.failure]: 'read-reports', [EXIT.waiting]: 'collect-only', [EXIT.dropped]: 'collect-only' },
};

/**
 * Where step 4b goes after `script` exits `code` (`EXIT`'s): `host-prepare`/`host-run`/`read-reports` (the next step),
 * `collect-only` (host-run's engine may still be running: resume with `--collect-only`, and never run that host's issues
 * locally, which would race it for the same branches), `unreachable` (the escalation-policy entry), `fix-command` (usage)
 * or `hitl` (a failed sync or prepare, or a code the script does not define).
 * @returns {'host-prepare'|'host-run'|'read-reports'|'collect-only'|'unreachable'|'fix-command'|'hitl'}
 */
export const routeHostExit = (script, code) => ROUTES[script]?.[code] ?? { [EXIT.unreachable]: 'unreachable', [EXIT.usage]: 'fix-command' }[code] ?? 'hitl';

/**
 * Which hosts a per-host resource preflight lets launch, from `{ host: preflight result }`: `launch` maps each `proceed`
 * host to its `recommendedParallel`, `held` each other host to its action (`wait` or `hitl`). A `critical` host holds only
 * its own sub-wave.
 * @returns {{launch: Record<string, number>, held: Record<string, 'wait'|'hitl'>}}
 */
export function hostLaunches(results) {
  const launch = {};
  const held = {};
  for (const [host, r] of Object.entries(results)) {
    if (r.action === 'proceed') launch[host] = r.recommendedParallel;
    else held[host] = r.action;
  }
  return { launch, held };
}

/**
 * The rate-limit decision for the whole wave. Every host shares one usage limit and the preflight reads the run family's
 * collected logs, so its one decision applies to every host. While any host's previous sub-wave is `uncollected` the logs
 * are incomplete, so the launch is held until it is.
 */
export const rateLimitGate = (decision, uncollected) => (uncollected.length > 0 ? { action: 'hold', uncollected } : decision);
