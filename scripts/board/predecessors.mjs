// predecessors.mjs — read the leaf tickets of the epics whose work came before a run, for the board's "Shipped
// before this run" section. The board only reads them, so the walk is its own: it takes the injected `ask` (one
// GraphQL query in, its parsed answer out) and batches the epics it still has to read, instead of going through
// plan-waves, which lists one epic per call and decides what ships.

import { parseRef, formatRef } from '../lib/ref.mjs';
import { hasSubIssues, subIssueRepo } from '../lib/sub-issues.mjs';

const BATCH = 40; // epics per query; with 100 sub-issues each page, 4,000 nodes at most, far under GitHub's 500,000
const NODE = 'number title url state stateReason closedAt repository{nameWithOwner} subIssuesSummary{total}';

/** One epic's alias in a query: its own title and url, and the page of sub-issues after `cursor`. Nothing nests below the page. */
function alias(item, i) {
  const { repo, number } = parseRef(item.ref);
  const [owner, name] = repo.split('/');
  const after = item.cursor ? `,after:${JSON.stringify(item.cursor)}` : '';
  return `e${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issue(number:${number}){title url `
    + `subIssues(first:100${after}){nodes{${NODE}} pageInfo{hasNextPage endCursor}}}}`;
}

/**
 * Every leaf below each `epics` ref, however deep: a sub-issue with sub-issues of its own is a container and is read
 * in turn (once, however many parents name it), one without is a leaf. A leaf under two epics belongs to the one whose
 * walk reaches it first, breadth first (a leaf listed directly under a later epic beats one nested deeper under an
 * earlier). Leaves are returned as GitHub has them, open ones included; the model decides what shipped.
 *
 * An epic GraphQL has no issue for is asked of `transferredTo` (its new ref, or null): one transferred to another repo
 * is read there, and its group keeps the ref it was named by, with the new home's url and title.
 *
 * @param {string[]} epics  `owner/repo#N` refs
 * @param {(query:string) => Promise<{data?:object}>} ask
 * @param {{transferredTo?: (ref:string) => Promise<string|null>}} [opts]
 * @returns {Promise<Array<{ref:string, url:string, title:string, leaves:Array<{ref:string,title:string,url:string,state:string,stateReason:string|null,closedAt:string|null}>}>>}
 * @throws when GitHub has no such epic (and `transferredTo` finds it nowhere else), or a listing holds sub-issues the
 *   token cannot read (null nodes), so a half-read epic is never shown as one that shipped less
 */
export async function fetchPredecessors(epics, ask, { transferredTo = async () => null } = {}) {
  const groups = epics.map((ref) => ({ ref, url: '', title: '', leaves: [] }));
  const seen = new Set(epics);
  const queue = groups.map((g) => ({ ref: g.ref, group: g, cursor: null, head: true }));
  while (queue.length) {
    const batch = queue.splice(0, BATCH);
    const { data } = await ask(`query{${batch.map(alias).join(' ')}}`);
    const lost = [];
    batch.forEach((item, i) => {
      const issue = data?.[`e${i}`]?.issue;
      if (!issue) { lost.push(item); return; }
      if (item.head) { Object.assign(item.group, { url: issue.url, title: issue.title }); }
      const nodes = issue.subIssues?.nodes ?? [];
      const unreadable = nodes.filter((n) => !n).length;
      if (unreadable) { throw new Error(`${item.ref}: ${unreadable} sub-issue${unreadable === 1 ? '' : 's'} could not be read`); }
      const parentRepo = parseRef(item.ref).repo;
      for (const node of nodes) {
        const ref = formatRef(subIssueRepo(node, parentRepo), node.number);
        if (seen.has(ref)) { continue; }
        seen.add(ref);
        if (hasSubIssues(node)) {
          queue.push({ ref, group: item.group, cursor: null });
        } else {
          const { number, repository, subIssuesSummary, ...leaf } = node;
          item.group.leaves.push({ ref, ...leaf });
        }
      }
      const page = issue.subIssues?.pageInfo;
      if (page?.hasNextPage) { queue.push({ ...item, cursor: page.endCursor }); }
    });
    for (const item of lost) {
      const to = await transferredTo(item.ref);
      if (!to) { throw new Error(`${item.ref}: GitHub has no such issue`); }
      queue.push({ ...item, ref: to });
    }
  }
  return groups;
}
