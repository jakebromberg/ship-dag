// host-prepare.mjs — plan how to ready a remote host for a wave: version parity, repo clones, the per-host config.
// Pure: the CLI (scripts/host-prepare.mjs) probes the host and runs the plan; this decides, and never touches a host.

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The host's entry with `coHome` defaulted, mirroring CO_HOME's default on the main Mac. */
export const withCoHome = (host) => ({ ...host, coHome: host.coHome ?? `${host.home}/Developer/claude-orchestrator` });

/**
 * `{ refusals, plan }`: a plan is ordered `{ step, ssh }` or `{ step, scp: [from, to] }` actions; any refusal empties it.
 * `repos` is `[{ repo, name, layoutDir }]` (`layoutDir` is where repo-layout.mjs puts it); `local` and `probe` hold
 * `{ sdSha, coSha, claudeHash }` (probe adds `distMtime`, `coCommitTime`, `configHash`, `freeGb`, `present` names).
 */
export function planHost({ name, host: raw, stateDir, configPath, repos, local, probe, minFreeGb = 10 }) {
  const host = withCoHome(raw);
  const refusals = [];
  for (const [label, key, dir] of [['ship-dag', 'sdSha', host.sdHome], ['claude-orchestrator', 'coSha', host.coHome]]) {
    if (probe[key] !== local[key]) {
      const build = key === 'coSha' ? ' && npm ci && npm run build' : '';
      refusals.push(`${name}: ${label} is at ${probe[key] || 'unknown'}, this Mac at ${local[key]}; run: ssh ${host.ssh} 'git -C ${dir} pull --ff-only${build}'`);
    }
  }
  if (!(probe.distMtime >= probe.coCommitTime)) refusals.push(`${name}: ${host.coHome}/dist is missing or older than its HEAD commit; run: ssh ${host.ssh} 'cd ${host.coHome} && npm ci && npm run build'`);
  if (probe.claudeHash !== local.claudeHash) refusals.push(`${name}: ~/.claude/CLAUDE.md differs from this Mac's; run host-sync-claude (#342) for ${name}`);
  if (!(probe.freeGb >= minFreeGb)) refusals.push(`${name}: ${probe.freeGb ?? 'unknown'} GB free under ${host.home}, below ${minFreeGb} GB; free space or lower --min-free-gb`);
  for (const { repo, name: dir, layoutDir } of repos) {
    if (layoutDir !== dir) refusals.push(`${name}: ${repo} lives at ${layoutDir}, not ${dir}, under reposDir (submodule layout); not supported, so not cloned`);
  }
  if (refusals.length) return { refusals, plan: [] };
  const plan = [];
  for (const { repo, name: dir } of repos) {
    const at = q(`${host.reposDir}/${dir}`);
    if (!probe.present.includes(dir)) plan.push({ step: `clone ${repo}`, ssh: `gh repo clone ${q(repo)} ${at}` });
    plan.push({ step: `fetch ${repo}`, ssh: `git -C ${at} fetch origin` });
  }
  plan.push({ step: 'mkdir stateDir', ssh: `mkdir -p ${q(stateDir)}` });
  if (probe.configHash !== local.configHash) plan.push({ step: 'copy config', scp: [configPath, `${stateDir}/config.json`] });
  return { refusals, plan };
}

/** The key=value script the CLI runs on the host: the facts `planHost` needs, one per line (a failed command leaves its value empty). */
export function probeScript(host, stateDir, repoNames) {
  const { home, sdHome, coHome, reposDir } = withCoHome(host);
  const hash = (f) => `$(shasum -a 256 ${q(f)} 2>/dev/null | cut -d' ' -f1)`;
  return [
    `echo sdSha=$(git -C ${q(sdHome)} rev-parse HEAD 2>/dev/null)`,
    `echo coSha=$(git -C ${q(coHome)} rev-parse HEAD 2>/dev/null)`,
    `echo coCommitTime=$(git -C ${q(coHome)} log -1 --format=%ct 2>/dev/null)`,
    `echo distMtime=$(stat -f %m ${q(`${coHome}/dist`)} 2>/dev/null)`,
    `echo claudeHash=${hash(`${home}/.claude/CLAUDE.md`)}`,
    `echo configHash=${hash(`${stateDir}/config.json`)}`,
    `echo freeKb=$(df -Pk ${q(home)} | awk 'NR==2{print $4}')`,
    ...repoNames.map((n) => `test -d ${q(`${reposDir}/${n}`)} && echo present=${n}`),
  ].join('; ');
}

/** Parse `probeScript` output into the `probe` object of `planHost`. */
export function parseProbe(out) {
  const probe = { present: [] };
  for (const line of out.split('\n')) {
    const [k, ...rest] = line.split('=');
    const v = rest.join('=');
    if (k === 'present') probe.present.push(v);
    else if (k) probe[k] = ['coCommitTime', 'distMtime', 'freeKb'].includes(k) ? (v === '' ? undefined : Number(v)) : v;
  }
  if (probe.freeKb !== undefined) probe.freeGb = probe.freeKb / 1048576;
  return probe;
}
