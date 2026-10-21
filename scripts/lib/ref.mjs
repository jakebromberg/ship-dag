// ref.mjs — the one place the telemetry modules parse and build `owner/repo#N` refs, say what a PR
// number is, read a recorded PR value (`parsePr`), and fold repos for comparison.

import { parseRef } from '../../plugins/ship-dag-eta/lib/ref.mjs';
export { REF_RE, parseRef } from '../../plugins/ship-dag-eta/lib/ref.mjs';

/** A bare `owner/repo`: one slash, no whitespace and no `#`, so a ref passed where a repo belongs is refused. */
export const REPO_RE = /^[^/#\s]+\/[^/#\s]+$/;

/** The `owner/repo#N` ref for `repo` and `number`, as the engine writes it. */
export const formatRef = (repo, number) => `${repo}#${number}`;

/** Whether `n` is a PR number: a positive integer. `1.5`, `'7'`, `0`, `-1` and null are not. */
export const isPr = (n) => Number.isInteger(n) && n > 0;

/** A repo or ref as a Map, Set or cache-dir key: case-folded, as GitHub compares names. */
export const refKey = (s) => String(s).toLowerCase();

/** The one key telemetry groups an issue's records by: the record's `owner/repo#N`, case-folded. */
export const issueKey = (record) => refKey(formatRef(record.repo, record.issue));

/**
 * Whether two repos (`owner/repo`) are the same one: GitHub names compare case-insensitively. Records
 * from different writers (sameEvent, ingest-wave's cost dedupe) compare through it, and escapes keys
 * by `refKey`. A report's lookups into its own rows and routing stay exact: a record finds its row by
 * the ref as written, and waveContextMatches pairs a report only with an entry or config whose refs
 * are the report's as written.
 */
export const sameRepo = (a, b) => refKey(a) === refKey(b);

const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/i;

/**
 * `{repo, pr}` for a telemetry record's or report row's PR value, or null when it is not one: a positive
 * integer or its digits as a string (in `homeRepo`), an `owner/repo#N` ref, or a `https://github.com/owner/repo/pull/N[/]`
 * URL (each in its own repo). Anything else (`'draft-11'`, `'#11'`, `0`, `-1`, null) is null. A PR is never parsed elsewhere.
 */
export function parsePr(value, homeRepo) {
  if (isPr(value)) return { repo: homeRepo, pr: value };
  if (typeof value !== 'string') return null;
  if (/^[1-9]\d*$/.test(value)) return { repo: homeRepo, pr: Number(value) };
  const ref = parseRef(value);
  if (ref && isPr(ref.number)) return { repo: ref.repo, pr: ref.number };
  const m = PR_URL_RE.exec(value);
  return m && isPr(Number(m[2])) ? { repo: m[1], pr: Number(m[2]) } : null;
}

/** Each folded repo of `records` mapped to the spelling first written in the log, in file order. */
export function repoSpellings(records) {
  const names = new Map();
  for (const r of records) if (!names.has(refKey(r.repo))) names.set(refKey(r.repo), r.repo);
  return names;
}

/** `population` grouped by folded repo as a Map, each group keyed by the spelling first written in all of `records`. */
export function groupByRepo(records, population) {
  const names = repoSpellings(records);
  const groups = new Map();
  for (const r of population) {
    const name = names.get(refKey(r.repo)) ?? r.repo;
    groups.set(name, [...(groups.get(name) ?? []), r]);
  }
  return groups;
}
