// host-prepare.mjs — plan how to ready a remote host for a wave: version parity, repo clones, the per-host config.
// Pure: the CLI (scripts/host-prepare.mjs) probes the host and runs the plan; this decides, and never touches a host.
import { normalizeRepo } from '../engine/repo-layout.mjs';
import { isLeaseHook } from './host-sync-claude.mjs';
import { shQuote as q } from './remote.mjs';

/**
 * The state dir an engine config was built for, or undefined when the config does not have emit-config's shape:
 * buildConfig writes `configDir` as `<stateDir>/state` and `worktreeDir` as `<stateDir>/worktrees`, and has no
 * `stateDir` field of its own, so the dir is `configDir` less its `/state`, with `worktreeDir` under it.
 */
export function configStateDir({ configDir, worktreeDir } = {}) {
  const stateDir = /^(\/.+)\/state$/.exec(configDir ?? '')?.[1];
  return stateDir && String(worktreeDir).startsWith(`${stateDir}/`) ? stateDir : undefined;
}

/**
 * Why a host cannot run Xcode work, or undefined when it can. `probe.xcodeError` is the first line `xcodebuild -version`
 * printed when it failed: a host with only the Command Line Tools has no xcodebuild at all, and an Xcode whose license
 * is not accepted refuses every tool, `git` included, with "You have not agreed to the Xcode license agreements".
 */
export function xcodeRefusal(probe, ssh = '<host>') {
  if (probe.xcodeVersion) return undefined;
  const error = probe.xcodeError;
  const path = probe.xcodePath || 'none';
  if (/license/i.test(error ?? '')) return `the Xcode license is not accepted (${error}); run: ssh -t ${ssh} 'sudo xcodebuild -license accept'`;
  if (/command line tools/i.test(error ?? '') || /CommandLineTools/.test(path) || !error) return `xcodebuild is not available and the active developer directory is ${path} (Command Line Tools only, or none); install Xcode.app and run: ssh -t ${ssh} 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer'`;
  return `xcodebuild -version failed (${error}); active developer directory ${path}`;
}

/**
 * `{ refusals, plan }`: a plan is ordered `{ step, ssh, slow? }` or `{ step, scp: [from, to] }` actions (`slow` marks a
 * clone); any refusal empties it. `host` is a validated hosts.json entry (`validateHosts`/`loadHosts`), so its `coHome`
 * is already defaulted. `config` is the engine config emit-config --by-host wrote, which must be this host's:
 * its state dir (`configStateDir`) under the host's `home` and its `projectRoot` the host's `reposDir`; the plan makes
 * that dir and copies the config there as `config.json`. `repos` is `[{ repo, name, layoutDir }]` (`layoutDir` is
 * where repo-layout.mjs puts it); `local` and `probe` hold `{ sdSha, coSha, claudeHash }` (probe adds `distNewest`,
 * `srcNewer`, `configHash`, `freeGb`, `leaseHook`, `present` names and their `origins`).
 */
export function planHost({ name, host, config, configPath, repos, local, probe, minFreeGb = 10, needs = [] }) {
  const refusals = [];
  if (needs.includes('xcode')) {
    const why = xcodeRefusal(probe, host.ssh);
    if (why) refusals.push(`${name}: ${why}`);
  }
  for (const [label, key, dir] of [['ship-dag', 'sdSha', host.sdHome], ['claude-orchestrator', 'coSha', host.coHome]]) {
    if (probe[key] !== local[key]) {
      const build = key === 'coSha' ? ' && npm ci && npm run build' : '';
      refusals.push(`${name}: ${label} is at ${probe[key] || 'unknown'}, this Mac at ${local[key]}; run: ssh ${host.ssh} 'cd ${dir} && git pull --ff-only${build}'`);
    }
  }
  const build = `run: ssh ${host.ssh} 'cd ${host.coHome} && npm ci && npm run build'`;
  if (!probe.distNewest) refusals.push(`${name}: ${host.coHome}/dist/src is missing; ${build}`);
  else if (probe.srcNewer) refusals.push(`${name}: ${host.coHome}/dist/src is older than ${probe.srcNewer}; ${build}`);
  const sync = `run: node scripts/host-sync-claude.mjs ${name}`;
  if (probe.claudeHash !== local.claudeHash) refusals.push(`${name}: ~/.claude/CLAUDE.md differs from this Mac's; ${sync}`);
  if (!probe.leaseHook) refusals.push(`${name}: ~/.claude/settings.json has no lease hook entry, so CO_LEASE_HOOK=on gates nothing; ${sync}`);
  if (!(probe.freeGb >= minFreeGb)) refusals.push(`${name}: ${probe.freeGb ?? 'unknown'} GB free under ${host.home}, below ${minFreeGb} GB; free space or lower --min-free-gb`);
  const wrongConfig = `pass the config emit-config --by-host wrote for ${name}`;
  const stateDir = configStateDir(config);
  if (!stateDir) refusals.push(`${name}: config configDir ${config.configDir} and worktreeDir ${config.worktreeDir} are not <dir>/state and a path under <dir>; ${wrongConfig}`);
  else if (!stateDir.startsWith(`${host.home}/`)) refusals.push(`${name}: config state dir ${stateDir} is not under ${host.home}/; ${wrongConfig}`);
  if (config.projectRoot !== host.reposDir) refusals.push(`${name}: config projectRoot ${config.projectRoot} is not ${host.reposDir}; ${wrongConfig}`);
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
 * so `distNewest` is the newest `.js` file under dist/src (a stray `.DS_Store` is not a build) and `srcNewer` the first
 * src `.ts` newer than it (empty when fresh), which also catches an uncommitted source edit. A present repo also reports
 * its `origin=<name>=<url>`. With no `stateDir` (a config planHost will refuse) there is no `configHash` line. `host` is
 * a validated hosts.json entry (`validateHosts`/`loadHosts`), so its `coHome` is already defaulted. With `xcode` the
 * script also reports `xcodePath` (`xcode-select -p`) and either `xcodeVersion` (the first line of `xcodebuild -version`)
 * or, when that fails, `xcodeError` (its first output line); without it no Xcode tool runs, so a node-only wave never
 * waits on one.
 */
export function probeScript(host, stateDir, repoNames, { xcode = false } = {}) {
  const { home, sdHome, coHome, reposDir } = host;
  const hash = (f) => `$(shasum -a 256 ${q(f)} 2>/dev/null | cut -d' ' -f1)`;
  return [
    `echo sdSha=$(git -C ${q(sdHome)} rev-parse HEAD 2>/dev/null)`,
    `echo coSha=$(git -C ${q(coHome)} rev-parse HEAD 2>/dev/null)`,
    `d=$(find ${q(`${coHome}/dist/src`)} -type f -name '*.js' -exec ls -t {} + 2>/dev/null | head -1)`,
    'echo distNewest=$d',
    `echo srcNewer=$(if test -n "$d"; then find ${q(`${coHome}/src`)} -type f -name '*.ts' -newer "$d" 2>/dev/null | head -1; fi)`,
    `echo claudeHash=${hash(`${home}/.claude/CLAUDE.md`)}`,
    `printf 'settingsBase64=%s\\n' "$(base64 2>/dev/null < ${q(`${home}/.claude/settings.json`)} | tr -d '\\n')"`,
    ...(stateDir ? [`echo configHash=${hash(`${stateDir}/config.json`)}`] : []),
    `echo freeKb=$(df -Pk ${q(home)} | awk 'NR==2{print $4}')`,
    ...(xcode ? ['echo xcodePath=$(xcode-select -p 2>/dev/null)', 'if x=$(xcodebuild -version 2>&1); then echo xcodeVersion=$(printf %s "$x" | head -n 1); else echo xcodeError=$(printf %s "$x" | head -n 1); fi'] : []),
    ...repoNames.map((n) => {
      const at = q(`${reposDir}/${n}`);
      return `if test -d ${at}; then echo present=${q(n)}; echo origin=${q(n)}=$(git -C ${at} remote get-url origin 2>/dev/null); fi`;
    }),
  ].join('; ');
}

/**
 * Parse `probeScript` output into the `probe` object of `planHost`; `leaseHook` is whether the host's settings.json
 * (absent, unreadable or invalid JSON: no) holds a lease hook entry, by host-sync-claude's `isLeaseHook`, under
 * `PreToolUse`, the event that gates. The probe sends the file base64-encoded on one line, so no shell `echo` rewrites
 * its backslashes and no newline in it can start a line that overwrites another key.
 */
export function parseProbe(out) {
  const probe = { present: [], origins: {} };
  for (const line of out.split('\n')) {
    const [k, ...rest] = line.split('=');
    const v = rest.join('=');
    if (k === 'present') probe.present.push(v);
    else if (k === 'origin') probe.origins[rest[0]] = rest.slice(1).join('=');
    else if (k) probe[k] = k === 'freeKb' ? (v === '' ? undefined : Number(v)) : v;
  }
  const gate = parseJson(Buffer.from(probe.settingsBase64 ?? '', 'base64').toString('utf8'))?.hooks?.PreToolUse;
  probe.leaseHook = Array.isArray(gate) && gate.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isLeaseHook));
  delete probe.settingsBase64;
  if (probe.freeKb !== undefined) probe.freeGb = probe.freeKb / 1048576;
  return probe;
}

const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
