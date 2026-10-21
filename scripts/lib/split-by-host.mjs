// split-by-host.mjs — group a ready-wave spec's issues by the host that runs them, so emit-config --by-host can write
// one engine config per host (a whole engine per host). Pure: the registry (lib/hosts.mjs) and the I/O are the CLI's.
//
// An issue's host is its own `host`, else its repo's (`spec.repos[repo].host`, carried from repo-ci-profiles.json by
// ci-profile.mjs), else `local`. A remote host must be in the registry (else throw, naming the issue) and must list the
// toolchains the repo's CI needs: the profile's declared `toolchains`, else those its commands' patterns imply. A
// repo-level host that falls short, or whose CI command matches no pattern (an opaque `scripts/ci`), keeps the issue
// local with a warning; an explicit per-issue host that lacks a needed toolchain throws.

const PATTERNS = {
  node: /\b(npm|npx|node|vitest|jest|tsc)\b/,
  python: /\b(python3?|pytest|uv|ruff|mypy|pip3?)\b/,
  xcode: /\b(xcodebuild|xcrun|swift\s+(build|test))\b/,
};

/** `{ toolchains, unrecognized }` for a CI profile: its declared toolchains, else those its commands imply plus the commands that imply none. */
export function toolchainsNeeded(profile) {
  if (profile?.toolchains) return { toolchains: profile.toolchains, unrecognized: [] };
  const toolchains = new Set();
  const unrecognized = [];
  for (const command of profile?.commands ?? []) {
    const hits = Object.keys(PATTERNS).filter((t) => PATTERNS[t].test(command));
    if (hits.length === 0) unrecognized.push(command);
    for (const t of hits) toolchains.add(t);
  }
  return { toolchains: [...toolchains], unrecognized };
}

/** `spec` re-pointed at a remote host: the same `ship-dag/engine/<runId>` state dir under its home, its repos dir and its ship-dag checkout. */
function onHost(spec, host, issues) {
  const tail = /ship-dag\/engine\/[^/]+(?=\/*$)/.exec(spec.stateDir)?.[0];
  if (!tail) throw new Error(`stateDir ${spec.stateDir} does not end in ship-dag/engine/<runId>, so it cannot be placed under ${host.home}`);
  return { ...spec, issues, stateDir: `${host.home}/.local/state/${tail}`, projectRoot: host.reposDir, promptTemplate: `${host.sdHome}/scripts/engine/prompt.md` };
}

/**
 * `{ [host]: subSpec }` for the hosts that have an issue, `local` included. A sub-spec is `spec` with only that host's
 * issues (and, for a remote host, its paths). `warn(message)` reports an issue kept local by the toolchain guard.
 */
export function splitByHost(spec, hosts, warn = () => {}) {
  const groups = {};
  for (const issue of spec.issues) {
    const repo = issue.repo || spec.repo;
    const ref = `${repo}#${issue.number}`;
    const profile = spec.repos?.[repo];
    const name = issue.host ?? profile?.host ?? 'local';
    let placed = name;
    if (name !== 'local') {
      if (!Object.hasOwn(hosts, name)) throw new Error(`unknown host ${JSON.stringify(name)} on ${ref}; known: local${Object.keys(hosts).map((h) => `/${h}`).join('')}.`);
      const { toolchains, unrecognized } = toolchainsNeeded(profile);
      const missing = toolchains.filter((t) => !hosts[name].toolchains.includes(t));
      if (issue.host != null && missing.length > 0) throw new Error(`host ${name} on ${ref} lacks the ${missing.join('/')} toolchain its CI needs.`);
      if (issue.host == null && (missing.length > 0 || unrecognized.length > 0)) {
        const why = missing.length > 0 ? `host ${name} lacks the ${missing.join('/')} toolchain its CI needs` : `its CI command ${unrecognized.map((c) => JSON.stringify(c)).join(', ')} implies no known toolchain, so host ${name} cannot be checked`;
        warn(`emit-config: WARNING — ${ref} stays on local: ${why}.`);
        placed = 'local';
      }
    }
    (groups[placed] ??= []).push(issue);
  }
  return Object.fromEntries(Object.entries(groups).map(([name, issues]) => [name, name === 'local' ? { ...spec, issues } : onHost(spec, hosts[name], issues)]));
}
