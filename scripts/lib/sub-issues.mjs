// sub-issues.mjs — list one epic's native sub-issues through `gh`.
//
// Shared by plan-waves.mjs (the recursive DAG fetch) and anything else that
// needs an epic's direct children. `runGh` is injected, so tests drive it with a
// fake and no network.

// One page of an epic's sub-issues. `subIssuesSummary.total` rides along on each
// child so the walk can tell a container from a leaf without a round trip of its
// own — on a wide epic that is one query instead of one-per-child.
export const SUB_ISSUES_QUERY =
  'query($owner:String!,$name:String!,$n:Int!,$cursor:String){repository(owner:$owner,name:$name)'
  + '{issue(number:$n){subIssues(first:100,after:$cursor){'
  + 'nodes{number state repository{nameWithOwner} subIssuesSummary{total} labels(first:20){nodes{name}}}'
  + 'pageInfo{hasNextPage endCursor}}}}}';

/** The label every wave sub-epic carries: one wave's issues, grouped under the run epic. */
export const WAVE_LABEL = 'ship-dag-wave';

/** Whether a sub-issue node (as `listSubIssues` returns it) carries `WAVE_LABEL`. */
export function hasWaveLabel(node) {
  return Boolean(node && node.labels && (node.labels.nodes || []).some((l) => l && l.name === WAVE_LABEL));
}

/** No sub-issues connection came back for an issue — bad number, deleted, no access, feature off. */
export class SubIssuesUnavailable extends Error {}

/**
 * Every sub-issue of one epic, following cursors so a large epic isn't silently
 * truncated. Throws `SubIssuesUnavailable` when GitHub reports no sub-issues
 * connection at all, leaving the caller to decide whether that is fatal (the
 * root epic) or merely a warning (a nested one).
 *
 * @param {{number:number, repo:string}} epicNode
 * @param {(argv:string[]) => string} runGh
 * @returns {Array<{number:number,state:string,repository:{nameWithOwner:string},subIssuesSummary?:{total:number}}>}
 */
export function listSubIssues(epicNode, runGh) {
  const [owner, name] = epicNode.repo.split('/');
  const out = [];
  let cursor = null;
  do {
    const argv = ['api', 'graphql', '-H', 'GraphQL-Features: sub_issues', '-f', `query=${SUB_ISSUES_QUERY}`,
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${epicNode.number}`];
    if (cursor) argv.push('-F', `cursor=${cursor}`);
    let resp;
    try {
      resp = JSON.parse(runGh(argv));
    } catch (err) {
      throw new SubIssuesUnavailable(`the sub-issues query failed: ${err.message}`);
    }
    const issue = resp && resp.data && resp.data.repository && resp.data.repository.issue;
    if (!issue || !issue.subIssues) {
      throw new SubIssuesUnavailable('no sub-issues returned (bad number, or the sub-issues '
        + `feature is unavailable): ${JSON.stringify((resp && resp.errors) || resp)}`);
    }
    out.push(...issue.subIssues.nodes);
    cursor = issue.subIssues.pageInfo.hasNextPage ? issue.subIssues.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}
