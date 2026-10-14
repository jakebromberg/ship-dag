// sub-issues.mjs — list one epic's native sub-issues through `gh`.
//
// Shared by plan-waves.mjs (the recursive DAG fetch) and anything else that
// needs an epic's direct children. `runGh` is injected, so tests drive it with a
// fake and no network; `realRunGh` is the one that shells out.

import { execFileSync } from 'node:child_process';

/** Run `gh` for real and return its stdout. */
export function realRunGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

// One page of an epic's sub-issues. `subIssuesSummary.total` rides along on each
// child so the walk can tell a container from a leaf without a round trip of its
// own — on a wide epic that is one query instead of one-per-child. `databaseId`
// (the REST id the sub-issues endpoints take) and `title` ride along for the
// wave sub-epic script, so it never looks either up per issue.
export const SUB_ISSUES_QUERY =
  'query($owner:String!,$name:String!,$n:Int!,$cursor:String){repository(owner:$owner,name:$name)'
  + '{issue(number:$n){subIssues(first:100,after:$cursor){'
  + 'nodes{number databaseId title state repository{nameWithOwner} subIssuesSummary{total} labels(first:100){nodes{name}}}'
  + 'pageInfo{hasNextPage endCursor}}}}}';

/** The label every wave sub-epic carries: one wave's issues, grouped under the run epic. */
export const WAVE_LABEL = 'ship-dag-wave';

/** The repo a sub-issue lives in: its own, which may differ from its parent's, else `parentRepo`. */
export function subIssueRepo(node, parentRepo) {
  return (node.repository && node.repository.nameWithOwner) || parentRepo;
}

/**
 * Whether an issue carries `WAVE_LABEL`. Takes either label shape: GraphQL's
 * `labels: { nodes: [{name}] }` (as `listSubIssues` returns it) or REST's and
 * `gh --json`'s `labels: [{name}]`.
 */
export function hasWaveLabel(node) {
  const labels = node && node.labels;
  const list = Array.isArray(labels) ? labels : (labels && labels.nodes) || [];
  return list.some((l) => l && l.name === WAVE_LABEL);
}

/** No sub-issues connection came back for an issue — bad number, deleted, no access, feature off. */
export class SubIssuesUnavailable extends Error {}

const connectionOf = (resp) => {
  const issue = resp && resp.data && resp.data.repository && resp.data.repository.issue;
  return issue && issue.subIssues;
};

// Whether a runGh failure is gh's exit on a GraphQL body with no connection and
// only NOT_FOUND errors: a bad number, a deleted issue or an unreadable repo.
function isNotFoundExit(err) {
  let body;
  try { body = JSON.parse(err && err.stdout); } catch { return false; }
  const errors = body && body.errors;
  return Array.isArray(errors) && errors.length > 0 && !connectionOf(body)
    && errors.every((e) => e && e.type === 'NOT_FOUND');
}

/**
 * Every sub-issue of one epic, following cursors so a large epic isn't silently
 * truncated. Throws `SubIssuesUnavailable` when the first page reports no
 * sub-issues connection at all (an exit-0 body without one, or gh's NOT_FOUND
 * exit), leaving the caller to decide whether that is fatal (the root epic) or
 * merely a warning (a nested one). Any other `runGh` failure propagates
 * unchanged. A body that is not JSON, a later page without a connection, and a
 * malformed `repo` or `pageInfo` throw a plain Error, so a half-read epic is
 * never mistaken for one without sub-issues.
 *
 * @param {{number:number, repo:string}} epicNode
 * @param {(argv:string[]) => string} runGh
 * @returns {Array<{number:number,databaseId?:number,title?:string,state:string,repository:{nameWithOwner:string},subIssuesSummary?:{total:number},labels?:{nodes:Array<{name:string}>}}>}
 */
export function listSubIssues(epicNode, runGh) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(epicNode.repo || '')) {
    throw new Error(`listSubIssues: repo must be owner/repo, got ${JSON.stringify(epicNode.repo)}`);
  }
  const [owner, name] = epicNode.repo.split('/');
  const ref = `${epicNode.repo}#${epicNode.number}`;
  const out = [];
  let cursor = null;
  do {
    const argv = ['api', 'graphql', '-H', 'GraphQL-Features: sub_issues', '-f', `query=${SUB_ISSUES_QUERY}`,
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${epicNode.number}`];
    if (cursor) argv.push('-F', `cursor=${cursor}`);
    let raw;
    try {
      raw = runGh(argv);
    } catch (err) {
      // gh exits 1 whenever a GraphQL response carries `errors`, so a missing
      // connection arrives here too, its body on `err.stdout`. Only that, on the
      // first page, is read; any other failure (rate limit, 502, network, auth)
      // propagates unchanged.
      if (cursor || !isNotFoundExit(err)) throw err;
      raw = err.stdout;
    }
    let resp;
    try {
      resp = JSON.parse(raw);
    } catch (err) {
      throw new Error(`listSubIssues: the sub-issues response for ${ref} was not JSON: ${err.message}`);
    }
    const connection = connectionOf(resp);
    if (!connection) {
      const said = JSON.stringify((resp && resp.errors) || resp);
      if (cursor) throw new Error(`listSubIssues: no sub-issues connection on a later page of ${ref}: ${said}`);
      throw new SubIssuesUnavailable(`no sub-issues returned (bad number, or the sub-issues feature is unavailable): ${said}`);
    }
    out.push(...connection.nodes);
    const info = connection.pageInfo;
    if (!info || (info.hasNextPage && !info.endCursor)) {
      throw new Error(`listSubIssues: malformed pageInfo for ${ref}: ${JSON.stringify(info)}`);
    }
    cursor = info.hasNextPage ? info.endCursor : null;
  } while (cursor);
  return out;
}
