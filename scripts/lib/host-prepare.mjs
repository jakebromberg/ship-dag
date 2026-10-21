// host-prepare.mjs — plan how to ready a remote host for a wave: version parity, repo clones, the per-host config.
// Pure: the CLI (scripts/host-prepare.mjs) probes the host and runs the plan; this decides, and never touches a host.
import { normalizeRepo } from '../engine/repo-layout.mjs';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The host's entry with `coHome` defaulted, mirroring CO_HOME's default on the main Mac. */
export const withCoHome = (host) => ({ ...host, coHome: host.coHome ?? `${host.home}/Developer/claude-orchestrator` });

/**
 * `{ refusals, plan }`: a plan is ordered `{ step, ssh, slow? }` or `{ step, scp: [from, to] }` actions (`slow` marks a
 * clone); any refusal empties it. `stateDir` and `projectRoot` are the config's, which must be this host's.
 * `repos` is `[{ repo, name, layoutDir }]` (`layoutDir` is where repo-layout.mjs puts it); `local` and `probe` hold
 * `{ sdSha, coSha, claudeHash }` (probe adds `distNewest`, `srcNewer`, `configHash`, `freeGb`, `present` names and
 * their `origins`).
 */
export function planHost({ name, host: raw, stateDir, projectRoot, configPath, repos, local, probe, minFreeGb = 10 }) {
  const host = withCoHome(raw);
  const refusals = [];
  for (const [label, key, dir] of [['ship-dag', 'sdSha', host.sdHome], ['claude-orchestrator', 'coSha', host.coHome]]) {
    if (probe[key] !== local[key]) {
      const build = key === 'coSha' ? ' && npm ci && npm run build' : '';
      refusals.push(`${name}: ${label} is at ${probe[key] || 'unknown'}, this Mac at ${local[key]}; run: ssh ${host.ssh} 'cd ${dir} && git pull --ff-only${build}'`);
    }
  }
  const build = `run: ssh ${host.ssh} 'cd ${host.coHome} && npm ci && npm run build'`;
  if (!probe.distNewest) refusals.push(`${name}: ${host.coHome}/dist/src is missing; ${build}`);
  else if (probe.srcNewer) refusals.push(`${name}: ${host.coHome}/dist/src is older than ${probe.srcNewer}; ${build}`);
  if (probe.claudeHash !== local.claudeHash) refusals.push(`${name}: ~/.claude/CLAUDE.md differs from this Mac's; run host-sync-claude (#342) for ${name}`);
  if (!(probe.freeGb >= minFreeGb)) refusals.push(`${name}: ${probe.freeGb ?? 'unknown'} GB free under ${host.home}, below ${minFreeGb} GB; free space or lower --min-free-gb`);
  const wrongConfig = `pass the config emit-config --by-host wrote for ${name}`;
  if (!String(stateDir).startsWith(`${host.home}/`)) refusals.push(`${name}: config stateDir ${stateDir} is not under ${host.home}/; ${wrongConfig}`);
  if (projectRoot !== host.reposDir) refusals.push(`${name}: config projectRoot ${projectRoot} is not ${host.reposDir}; ${wrongConfig}`);
  const owners = new Map();
  for (const { repo, name: dir, layoutDir } of repos) {
    const at = `${host.reposDir}/${dir}`;
    if (layoutDir !== dir) refusals.push(`${name}: ${repo} lives at ${layoutDir}, not ${dir}, under reposDir (submodule layout); not supported, so not cloned`);
    if (owners.has(dir)) refusals.push(`${name}: ${owners.get(dir)} and ${repo} both clone to ${at}; not supported`);
    owners.set(dir, repo);
    const origin = probe.origins?.[dir];
    if (probe.present.includes(dir) && normalizeRepo(origin) !== normalizeRepo(repo)) refusals.push(`${name}: ${at} exists but its origin is ${origin || 'unset'}, not ${repo}; move it aside`);
  }
  if (refusals.length) return { refusals, plan: [] };
  const plan = [];
  for (const { repo, name: dir } of repos) {
    const at = q(`${host.reposDir}/${dir}`);
    if (!probe.present.includes(dir)) plan.push({ step: `clone ${repo}`, ssh: `gh repo clone ${q(repo)} ${at}`, slow: true });
    plan.push({ step: `fetch ${repo}`, ssh: `git -C ${at} fetch origin` });
  }
  plan.push({ step: 'mkdir stateDir', ssh: `mkdir -p ${q(stateDir)}` });
  if (probe.configHash !== local.configHash) plan.push({ step: 'copy config', scp: [configPath, `${stateDir}/config.json`] });
  return { refusals, plan };
}

/**
 * The key=value script the CLI runs on the host: the facts `planHost` needs, one per line (a failed command leaves its
 * value empty). Every line exits 0, so an absent repo or file never fails the probe. Dist freshness compares files, not
 * the commit time: `tsc` (no clean) rewrites every output under dist/src on each build but never touches `dist` itself,
 * so `distNewest` is the newest file under dist/src and `srcNewer` the first src `.ts` newer than it (empty when fresh),
 * which also catches an uncommitted source edit. A present repo also reports its `origin=<name>=<url>`.
 */
export function probeScript(host, stateDir, repoNames) {
  const { home, sdHome, coHome, reposDir } = withCoHome(host);
  const hash = (f) => `$(shasum -a 256 ${q(f)} 2>/dev/null | cut -d' ' -f1)`;
  return [
    `echo sdSha=$(git -C ${q(sdHome)} rev-parse HEAD 2>/dev/null)`,
    `echo coSha=$(git -C ${q(coHome)} rev-parse HEAD 2>/dev/null)`,
    `d=$(find ${q(`${coHome}/dist/src`)} -type f -exec ls -t {} + 2>/dev/null | head -1)`,
    'echo distNewest=$d',
    `echo srcNewer=$(if test -n "$d"; then find ${q(`${coHome}/src`)} -type f -name '*.ts' -newer "$d" 2>/dev/null | head -1; fi)`,
    `echo claudeHash=${hash(`${home}/.claude/CLAUDE.md`)}`,
    `echo configHash=${hash(`${stateDir}/config.json`)}`,
    `echo freeKb=$(df -Pk ${q(home)} | awk 'NR==2{print $4}')`,
    ...repoNames.map((n) => {
      const at = q(`${reposDir}/${n}`);
      return `if test -d ${at}; then echo present=${q(n)}; echo origin=${q(n)}=$(git -C ${at} remote get-url origin 2>/dev/null); fi`;
    }),
  ].join('; ');
}

/** Parse `probeScript` output into the `probe` object of `planHost`. */
export function parseProbe(out) {
  const probe = { present: [], origins: {} };
  for (const line of out.split('\n')) {
    const [k, ...rest] = line.split('=');
    const v = rest.join('=');
    if (k === 'present') probe.present.push(v);
    else if (k === 'origin') probe.origins[rest[0]] = rest.slice(1).join('=');
    else if (k) probe[k] = k === 'freeKb' ? (v === '' ? undefined : Number(v)) : v;
  }
  if (probe.freeKb !== undefined) probe.freeGb = probe.freeKb / 1048576;
  return probe;
}
