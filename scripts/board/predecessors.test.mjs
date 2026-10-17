// Tests for the predecessor walk. `ask` is a fake GraphQL endpoint over a table of epics (ref → its children, each
// a leaf or the ref of another epic); it pages at `pageSize` and records each query's epics, so the tests can check
// the walk is recursive, paged and batched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPredecessors } from './predecessors.mjs';

const R = (n) => `o/r#${n}`;
const ALIAS = /(e\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)\{issue\(number:(\d+)\)\{[^{]*subIssues\(first:100(?:,after:"([^"]*)")?\)/g;

function fakeAsk(tree, { pageSize = 100 } = {}) {
  const calls = [];
  const ask = async (query) => {
    const asked = [...query.matchAll(ALIAS)].map(([, key, owner, name, n, after]) => ({ key, ref: `${owner}/${name}#${n}`, after }));
    calls.push(asked.map((a) => a.ref));
    const data = Object.fromEntries(asked.map(({ key, ref, after }) => {
      const epic = tree[ref];
      if (!epic) { return [key, { issue: null }]; }
      const start = Number(after ?? 0);
      const kids = epic.kids.slice(start, start + pageSize);
      const nodes = kids.map((kid) => {
        const child = typeof kid === 'string' ? { ref: kid, ...tree[kid] } : kid;
        const [repo, number] = child.ref.split('#');
        return { number: Number(number), title: `T${number}`, url: `https://github.com/${repo}/issues/${number}`, state: child.state ?? 'CLOSED',
          stateReason: child.stateReason ?? 'COMPLETED', closedAt: child.closedAt ?? '2026-09-01T00:00:00Z',
          repository: { nameWithOwner: repo }, subIssuesSummary: { total: child.kids?.length ?? 0 } };
      });
      const more = start + pageSize < epic.kids.length;
      return [key, { issue: { title: `Epic ${ref}`, url: `https://github.com/${ref.replace('#', '/issues/')}`, subIssues: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? String(start + pageSize) : null } } } }];
    }));
    return { data };
  };
  return { ask, calls };
}

const leafRefs = (group) => group.leaves.map((l) => l.ref);

test('walks nested epics to their leaves, containers excluded, titles and urls kept', async () => {
  const { ask } = fakeAsk({
    [R(1)]: { kids: [R(2), R(3), R(4)] }, [R(2)]: { kids: [R(5), R(6)] }, [R(4)]: { kids: [R(7)] },
    [R(3)]: { kids: [] }, [R(5)]: { kids: [] }, [R(6)]: { kids: [] }, [R(7)]: { kids: [] },
  });
  const [g] = await fetchPredecessors([R(1)], ask);
  assert.deepEqual(leafRefs(g).sort(), [R(3), R(5), R(6), R(7)]);
  assert.equal(g.title, `Epic ${R(1)}`);
  assert.equal(g.url, 'https://github.com/o/r/issues/1');
  assert.deepEqual(Object.keys(g.leaves[0]).sort(), ['closedAt', 'ref', 'state', 'stateReason', 'title', 'url']);
});

test('pages an epic past 100 sub-issues, and reads sibling epics together in one query', async () => {
  const kids = Array.from({ length: 5 }, (_, i) => R(100 + i));
  const tree = { [R(1)]: { kids }, [R(2)]: { kids: [R(200)] }, ...Object.fromEntries([...kids, R(200)].map((k) => [k, { kids: [] }])) };
  const { ask, calls } = fakeAsk(tree, { pageSize: 2 });
  const [a, b] = await fetchPredecessors([R(1), R(2)], ask);
  assert.deepEqual(leafRefs(a), kids);
  assert.deepEqual(leafRefs(b), [R(200)]);
  assert.deepEqual(calls, [[R(1), R(2)], [R(1)], [R(1)]], 'both epics in the first query, then the two later pages of the first');
});

test('batches 40 epics to a query', async () => {
  const kids = Array.from({ length: 85 }, (_, i) => R(100 + i));
  const tree = { [R(1)]: { kids }, ...Object.fromEntries(kids.map((k) => [k, { kids: [R(1000 + Number(k.split('#')[1]))] }])) };
  for (const k of kids) { tree[R(1000 + Number(k.split('#')[1]))] = { kids: [] }; }
  const { ask, calls } = fakeAsk(tree);
  const [g] = await fetchPredecessors([R(1)], ask);
  assert.equal(g.leaves.length, 85);
  assert.deepEqual(calls.map((c) => c.length), [1, 40, 40, 5]);
});

test('a container reached twice is read once, a leaf under two epics belongs to the first, and a cycle ends', async () => {
  const { ask, calls } = fakeAsk({
    [R(1)]: { kids: [R(3), R(9)] }, [R(2)]: { kids: [R(3), R(9)] }, [R(3)]: { kids: [R(1), R(4)] }, [R(4)]: { kids: [] }, [R(9)]: { kids: [] },
  });
  const [a, b] = await fetchPredecessors([R(1), R(2)], ask);
  assert.deepEqual(leafRefs(a).sort(), [R(4), R(9)]);
  assert.deepEqual(leafRefs(b), []);
  assert.equal(calls.flat().filter((r) => r === R(3)).length, 1);
});

test('an epic GitHub has no issue for throws, naming it', async () => {
  await assert.rejects(fetchPredecessors([R(1), R(404)], fakeAsk({ [R(1)]: { kids: [] } }).ask), new RegExp(`${R(404)}: GitHub has no such issue`));
});

test('a cross-repo sub-issue keeps its own repo in its ref', async () => {
  const { ask } = fakeAsk({ [R(1)]: { kids: [{ ref: 'x/y#7' }] } });
  assert.deepEqual(leafRefs((await fetchPredecessors([R(1)], ask))[0]), ['x/y#7']);
});
