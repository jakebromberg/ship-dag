// sub-issues.mjs — list one epic's native sub-issues through `gh`.
//
// Shared by plan-waves.mjs (the recursive DAG fetch) and anything else that
// needs an epic's direct children. `runGh` is injected, so tests drive it with a
// fake and no network; `realRunGh` (gh.mjs) is the one that shells out.

import { ghErrorBody } from './gh.mjs';

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

/** Whether a sub-issue has sub-issues of its own, from the `subIssuesSummary` that rides along on it. */
export function hasSubIssues(node) {
  return Boolean(node && node.subIssuesSummary && node.subIssuesSummary.total > 0);
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

/**
 * No sub-issues connection came back for an issue: a bad number, a deleted
 * issue, or a repo the token cannot read (GitHub's NOT_FOUND). Any other
 * GraphQL error, a schema error included, is a `runGh` failure instead.
 */
export class SubIssuesUnavailable extends Error {}

const connectionOf = (resp) => {
  const issue = resp && resp.data && resp.data.repository && resp.data.repository.issue;
  return issue && issue.subIssues;
};

const unavailable = (said) => new SubIssuesUnavailable(`no sub-issues returned (bad number, deleted, or no access): ${said}`);

// The sub-issues an errored listing could not read. Each error whose path runs
// into `subIssues.nodes[i]` names that node: by its number when the node came
// back, else by its position in the whole listing (`offset` nodes precede this
// page), with GitHub's type and message. A null node no error names is counted.
function unreadableNodes(connection, errors, offset) {
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
  const named = new Map(); // node index -> its description, from the first error naming it
  for (const e of errors) {
    const path = (e && e.path) || [];
    const at = path.indexOf('subIssues');
    const i = path[at + 2];
    if (at < 0 || path[at + 1] !== 'nodes' || !Number.isInteger(i) || named.has(i)) continue;
    const who = nodes[i] && nodes[i].number ? `#${nodes[i].number}` : `sub-issue ${offset + i + 1}`;
    named.set(i, `${who} (${e.type}: ${e.message})`);
  }
  const rest = nodes.filter((n, i) => !n && !named.has(i)).length;
  return { named: [...named.values()], rest };
}

// What to throw for a runGh failure. gh exits 1 whenever a GraphQL response
// carries `errors`, with the body on `err.stdout`, so two such bodies are read:
// a first page with no connection and only NOT_FOUND errors is
// `SubIssuesUnavailable`, and a connection with sub-issues the token cannot read
// is a plain Error naming them, failing closed rather than dropping them. Any
// other failure (rate limit, 502, network, auth) is `err`, unchanged.
function failureOf(err, { ref, first, offset }) {
  const body = ghErrorBody(err);
  if (!body) return err;
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const connection = connectionOf(body);
  if (!connection) {
    const notFound = first && errors.length > 0 && errors.every((e) => e && e.type === 'NOT_FOUND');
    return notFound ? unavailable(JSON.stringify(errors)) : err;
  }
  const { named, rest } = unreadableNodes(connection, errors, offset);
  const count = named.length + rest;
  if (!count) return err;
  const list = named.length ? `: ${named.join(', ')}${rest ? `, and ${rest} more` : ''}` : '';
  return new Error(`listSubIssues: ${count} sub-issue${count === 1 ? '' : 's'} of ${ref} could not be read${list}`, { cause: err });
}

/**
 * Every sub-issue of one epic, following cursors so a large epic isn't silently
 * truncated. Throws `SubIssuesUnavailable` when the first page reports no
 * sub-issues connection at all (an exit-0 body without one, or gh's NOT_FOUND
 * exit), leaving the caller to decide whether that is fatal (the root epic) or
 * merely a warning (a nested one). A listing with sub-issues the token cannot
 * read (null nodes and their NOT_FOUND or FORBIDDEN errors) throws a plain Error
 * naming them, with the gh error as `cause`. Any other `runGh` failure
 * propagates unchanged. A body that is not JSON, a later page without a
 * connection, and a malformed `repo`, `nodes` or `pageInfo` throw a plain Error,
 * so a half-read epic is never mistaken for one without sub-issues.
 *
 * @param {{number:number, repo:string}} epicNode
 * @param {(argv:string[]) => string} runGh
 * @returns {Array<{number:number,databaseId?:number,title?:string,state:string,repository:{nameWithOwner:string},subIssuesSummary?:{total:number},labels?:{nodes:Array<{name:string}>}}>}
 */
export function listSubIssues(epicNode, runGh) {
  if (!/^[^/#\s]+\/[^/#\s]+$/.test(epicNode.repo || '')) {
    throw new Error(`listSubIssues: repo must be owner/repo, got ${JSON.stringify(epicNode.repo)}`);
  }
  const [owner, name] = epicNode.repo.split('/');
  const ref = `${epicNode.repo}#${epicNode.number}`;
  const out = [];
  let cursor = null;
  do {
    const argv = ['api', 'graphql', '-H', 'GraphQL-Features: sub_issues', '-f', `query=${SUB_ISSUES_QUERY}`,
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${epicNode.number}`];
    if (cursor) argv.push('-f', `cursor=${cursor}`);
    let raw;
    try {
      raw = runGh(argv);
    } catch (err) {
      throw failureOf(err, { ref, first: !cursor, offset: out.length });
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
      throw unavailable(said);
    }
    if (!Array.isArray(connection.nodes) || connection.nodes.some((n) => !n)) {
      throw new Error(`listSubIssues: malformed nodes for ${ref}: ${JSON.stringify(connection.nodes)}`);
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
