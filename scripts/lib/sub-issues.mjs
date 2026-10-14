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

/**
 * Every sub-issue of one epic, following cursors so a large epic isn't silently
 * truncated. Throws `SubIssuesUnavailable` when GitHub reports no sub-issues
 * connection at all, leaving the caller to decide whether that is fatal (the
 * root epic) or merely a warning (a nested one). Any other failure (`runGh`
 * throwing, a malformed `repo` or `pageInfo`) is a plain Error and propagates.
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
  const out = [];
  let cursor = null;
  do {
    const argv = ['api', 'graphql', '-H', 'GraphQL-Features: sub_issues', '-f', `query=${SUB_ISSUES_QUERY}`,
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${epicNode.number}`];
    if (cursor) argv.push('-F', `cursor=${cursor}`);
    // A runGh failure (rate limit, 502, auth) propagates: it says nothing about the connection.
    const raw = runGh(argv);
    let resp;
    try {
      resp = JSON.parse(raw);
    } catch (err) {
      throw new SubIssuesUnavailable(`the sub-issues response was not JSON: ${err.message}`);
    }
    const issue = resp && resp.data && resp.data.repository && resp.data.repository.issue;
    if (!issue || !issue.subIssues) {
      throw new SubIssuesUnavailable('no sub-issues returned (bad number, or the sub-issues '
        + `feature is unavailable): ${JSON.stringify((resp && resp.errors) || resp)}`);
    }
    out.push(...issue.subIssues.nodes);
    const info = issue.subIssues.pageInfo;
    if (!info || (info.hasNextPage && !info.endCursor)) {
      throw new Error(`listSubIssues: malformed pageInfo for ${epicNode.repo}#${epicNode.number}: ${JSON.stringify(info)}`);
    }
    cursor = info.hasNextPage ? info.endCursor : null;
  } while (cursor);
  return out;
}
