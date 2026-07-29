#!/usr/bin/env node
// corpus.mjs — build a frozen eval corpus of real merged WXYC issues.
//
// Each corpus entry is an issue that was actually shipped: the merged PR is its
// known-good reference and `baseSha` is the commit the implementer started from
// (the parent of the PR's first commit — correct for both merge and rebase
// strategies). The committed corpus.json is canonical; re-running `build`
// regenerates it but the manifest is intentionally timestamp-free so it stays
// diff-stable. Corpus tiering is size-based (the PR list exposes changedFiles +
// additions, not file paths), so path/label complex-signals don't apply here.
//
// Usage:
//   node corpus.mjs build --repos owner/a,owner/b [--per-tier N] [--limit M] > corpus.json
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

import { execFileSync } from 'node:child_process';
import { complexityTier } from './lib/tier.mjs';

const TIERS = ['mechanical', 'normal', 'complex'];

function defaultRunGh(argv) {
  return execFileSync('gh', argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Parse `gh pr list --json ...` output into candidates, keeping only PRs that
 * close an issue (the issue is the corpus unit; the PR is its reference). A PR
 * closing multiple issues is recorded against its first reference only; extras
 * are rare in practice and simply go unsampled.
 * @param {string|object[]} json
 */
export function parseMergedPRList(json) {
  const prs = typeof json === 'string' ? JSON.parse(json) : json;
  return prs
    .filter((p) => p.closingIssuesReferences && p.closingIssuesReferences.length > 0)
    .map((p) => ({
      pr: p.number,
      issue: p.closingIssuesReferences[0].number,
      changedFiles: p.changedFiles ?? 0,
      additions: p.additions ?? 0,
      title: p.title ?? '',
      mergeSha: p.mergeCommit?.oid ?? null,
    }));
}

/**
 * Tier each candidate and take up to `perTier` per tier, most-recent-first
 * (highest PR number) so selection is deterministic and reproducible.
 */
export function stratifyAndSample(candidates, perTier, tierFn = complexityTier) {
  const withTier = candidates.map((c) => ({ ...c, tier: tierFn(c) }));
  const out = [];
  for (const tier of TIERS) {
    const inTier = withTier.filter((c) => c.tier === tier).sort((a, b) => b.pr - a.pr);
    out.push(...inTier.slice(0, perTier));
  }
  return out;
}

function repoDefaultBranch(repo, runGh) {
  return JSON.parse(runGh(['repo', 'view', repo, '--json', 'defaultBranchRef'])).defaultBranchRef.name;
}

function listMergedPRs(repo, limit, runGh) {
  return runGh(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(limit),
    '--json', 'number,closingIssuesReferences,changedFiles,additions,title,mergeCommit']);
}

/** Parent of the PR's first commit = the base the implementer started from. */
function prBaseSha(repo, pr, runGh) {
  try {
    const { commits } = JSON.parse(runGh(['pr', 'view', String(pr), '--repo', repo, '--json', 'commits']));
    if (!commits || !commits.length) return null;
    return runGh(['api', `repos/${repo}/commits/${commits[0].oid}`, '--jq', '.parents[0].sha']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build a corpus across `repos`, sampling `perTier` issues per complexity tier
 * per repo from the last `limit` merged PRs. Returns { perTier, limit, repos,
 * entries[], warnings[] }. gh is injectable for tests.
 */
export function buildCorpus({ repos, perTier = 2, limit = 40, runGh = defaultRunGh }) {
  const entries = [];
  const warnings = [];
  for (const repo of repos) {
    try {
      let defaultBranch = 'main';
      try {
        defaultBranch = repoDefaultBranch(repo, runGh);
      } catch (e) {
        warnings.push(`${repo}: default-branch lookup failed (${e.message})`);
      }
      const sampled = stratifyAndSample(parseMergedPRList(listMergedPRs(repo, limit, runGh)), perTier);
      if (sampled.length === 0) warnings.push(`${repo}: no merged PRs with linked issues in the last ${limit}`);
      for (const s of sampled) {
        const baseSha = prBaseSha(repo, s.pr, runGh);
        if (!baseSha || !s.mergeSha) {
          // An entry the replay can't check out is worse than a smaller corpus — drop it, loudly.
          warnings.push(`${repo}#${s.issue} (PR ${s.pr}): dropped — missing ${!baseSha ? 'baseSha' : 'mergeSha'}`);
          continue;
        }
        entries.push({
          repo,
          defaultBranch,
          issue: s.issue,
          pr: s.pr,
          mergeSha: s.mergeSha,
          baseSha,
          tier: s.tier,
          changedFiles: s.changedFiles,
          additions: s.additions,
          title: s.title,
        });
      }
    } catch (e) {
      // Isolate a repo-level failure (list error, rename, rate-limit) so the rest still build.
      warnings.push(`${repo}: skipped — ${e.message}`);
    }
  }
  return { perTier, limit, repos, entries, warnings };
}

const USAGE = 'usage: corpus.mjs build --repos owner/a,owner/b [--per-tier N] [--limit M]';

function die(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(2);
}

function posInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) die(`${flag} requires a positive integer (got ${JSON.stringify(raw)})`);
  return n;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'build') die(`unknown command: ${cmd ?? '(none)'}`);
  const opts = { repos: [], perTier: 2, limit: 40 };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--repos') {
      const v = rest[++i];
      if (!v) die('--repos requires a value');
      opts.repos = v.split(',').filter(Boolean);
    } else if (rest[i] === '--per-tier') opts.perTier = posInt(rest[++i], '--per-tier');
    else if (rest[i] === '--limit') opts.limit = posInt(rest[++i], '--limit');
    else die(`unknown argument: ${rest[i]}`);
  }
  if (!opts.repos.length) die('--repos requires at least one owner/repo');
  const corpus = buildCorpus(opts);
  for (const w of corpus.warnings) process.stderr.write(`warning: ${w}\n`);
  if (corpus.entries.length === 0) {
    // Never emit an empty corpus to stdout: `build > corpus.json` would clobber the canonical file.
    process.stderr.write('error: no corpus entries built — refusing to write an empty corpus (canonical corpus.json left intact)\n');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(corpus, null, 2)}\n`);
  process.stderr.write(`corpus: ${corpus.entries.length} entries across ${opts.repos.length} repos\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
