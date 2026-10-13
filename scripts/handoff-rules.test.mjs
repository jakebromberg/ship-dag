// Pins the review/fix hand-off rules: the capacity-sized limit, nothing handed
// over at critical, "start anyway" handing over exactly one PR, the lease-wait
// return routing (in SKILL.md and both workflow.js prompts), and point F's table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const unescaped = (src) => src.replaceAll('\\`', '`');
const skill = read('SKILL.md');
const policy = read('references/escalation-policy.md');
const lines = skill.split('\n');
const step4d = lines.find((l) => l.startsWith('**d. Review pass'));
const step5 = skill.split('### 5. Reconcile each result')[1].split('\n### ')[0];
const blockingBullet = step5.split('\n').find((l) => l.startsWith('- **Blocking finding**'));
const block = (heading) => skill.split(heading)[1].split(/\n### |\n## /)[0];
const workflow = unescaped(read('workflow.js'));

const HANDOFF_RULES = [
  /[Rr]un `node "\$SD\/scripts\/resource-preflight\.mjs" check` and hand over at most `recommendedHandoff` PRs in that invocation/,
  /`recommendedHandoff` is `max\(1, capacity − live\.length\)`, 1 when `capacity` is null or the reason is `no-signal`, and 0 at `critical`/,
  /hand over the rest in later invocations, re-reading the preflight each time/,
  /Nothing is handed over at `critical`: `critical-wait` waits \(re-run with `--sleep-before 60 --waited-minutes <total minutes waited before this call>`\) and `critical-hitl` goes to HITL point F/,
  /"Start anyway" for a hand-off hands over exactly 1 PR/,
  /no environment prefix reaches an Agent-tool subagent, so `CO_PRESSURE_OVERRIDE` cannot apply/,
  /say so when you offer the choice/,
];
const ROUTING = /A Review or fix subagent that ends with `orchestrator-stop: lease-wait` has given up on the lease: that is not a review verdict and not a model failure, so write no round file for it, put its PR back in the hand-off queue for the next capacity read, and after two such returns for the same PR in a run go to HITL point F\./;
const RETURN = /If you gave up on the lease \(`orchestrator-stop: lease-wait`\), return `status: "error"` with `notes: "lease-wait"`\./;

for (const [name, text] of [['step 4d', step4d], ['step 5', blockingBullet]]) {
  for (const rule of HANDOFF_RULES) test(`${name} pins the hand-off rule: ${rule.source.slice(0, 48)}…`, () => assert.match(text, rule));
  test(`${name} pins the lease-wait routing`, () => assert.match(text, ROUTING));
}

const copies = {
  "SKILL.md's Implement block": block('### Implement (Sonnet, own worktree)'),
  "SKILL.md's Review block": block('### Review (Opus, own worktree)'),
  "workflow.js's implementPrompt": workflow.split('function implementPrompt')[1].split('function reviewPathFor')[0],
  "workflow.js's reviewPrompt": workflow.split('function reviewPrompt')[1],
};
for (const [name, text] of Object.entries(copies)) {
  test(`${name} maps the lease-wait give-up to status "error"`, () => assert.match(text, RETURN));
}

test("workflow.js's REVIEW_SCHEMA carries the status and notes the give-up returns", () => {
  const schema = workflow.split('const REVIEW_SCHEMA')[1].split('function implementPrompt')[0];
  assert.match(schema, /status: \{/);
  assert.match(schema, /notes: \{/);
});

const pointF = policy.slice(policy.indexOf('## Point F')).split(/\n## /)[0];
const row = (label) => {
  const line = pointF.split('\n').find((l) => l.startsWith(`| ${label} |`));
  assert.ok(line, `point F's table has no "${label}" row`);
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  assert.equal(cells.length, 4, `${label}: step, trigger, wait, start anyway`);
  return cells;
};

test('point F opens its table with the four columns', () => {
  assert.match(pointF, /\| Guarded step \| Triggers point F \| "wait" resets \| "Start anyway" does \|/);
});

for (const [label, trigger, wait, anyway] of [
  ['Engine invocation', /the step-4 preflight reads `critical-hitl`: `critical` after 15 minutes waited/, /the summed-wait counter, to 0/, /an inline `CO_PRESSURE_OVERRIDE=critical-as-warning` prefix plus `--parallel 1`/],
  ['Step 6\\.2 CI re-run', /summed lease waits pass 15 minutes at `critical`, or pass 30 minutes at any pressure/, /the summed lease-wait counter, to 0/, /at non-critical pressure a plain rerun, since the override changes nothing below `critical`/],
  ['Review\\/fix hand-off', /the step 4d\/5 preflight reads `critical-hitl`, or one PR returns `lease-wait` twice in a run/, /the summed-wait counter, to 0, and that PR's return count/, /hands over exactly 1 PR, with no override prefix/],
]) {
  test(`point F's table pins the ${label} row's three cells`, () => {
    const [, t, w, a] = row(label.replaceAll('\\', ''));
    assert.match(t, trigger);
    assert.match(w, wait);
    assert.match(a, anyway);
  });
}

test('step 4 hitl bullet and the preflight header point at the table', () => {
  assert.match(skill, /per-step table in `references\/escalation-policy\.md`/);
  assert.match(read('scripts/resource-preflight.mjs'), /point F's per-step table in references\/escalation-policy\.md/);
});

test('README mentions that review and fix fan-out is sized from lease capacity', () => {
  assert.match(read('README.md'), /[Rr]eview and fix hand-offs are sized from lease capacity/);
});
