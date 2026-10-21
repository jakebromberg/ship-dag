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
const ROUTING = /A Review or fix subagent has given up on the lease when its return ends with the closing line `orchestrator-stop: lease-wait`/;
const FALLBACK_SIGNAL = /on the workflow\.js fallback, where returns are schema-constrained, a review return with `status: "error"`, `notes: "lease-wait"`, an empty `path` and `findingCount` 0/;
const CHECK_FIRST = /Check for it before running `review-gate\.mjs` or reading a `\/review-loop` result as non-convergence, and never run `review-gate\.mjs` on such a return/;
const REQUEUE = /not a review verdict and not a model failure, so no round file exists for it \(the Review subagent writes none and deletes a partial one it started[^)]*\), put its PR back in the hand-off queue for the next capacity read, and after two such returns for the same PR in a run go to HITL point F/;
const RETURN = /If you gave up on the lease \(`orchestrator-stop: lease-wait`\), return `status: "error"` with `notes: "lease-wait"`\./;
// The Review block and workflow.js's reviewPrompt must agree on the file rule.
const NO_REVIEW_FILE = /If you gave up on the lease \(`orchestrator-stop: lease-wait`\), write no review file and delete a partial one you started\./;
const CLOSING_LINE_RETURN = /return only the closing line `orchestrator-stop: lease-wait` instead of the summary/;
const SCHEMA_RETURN = /return `status: "error"` with `notes: "lease-wait"`, `path` "" and `findingCount` 0 instead of the summary/;

for (const rule of HANDOFF_RULES) test(`step 4d pins the hand-off rule: ${rule.source.slice(0, 48)}…`, () => assert.match(step4d, rule));
for (const [label, rule] of [['routing', ROUTING], ['fallback signal', FALLBACK_SIGNAL], ['check-first rule', CHECK_FIRST], ['requeue rule', REQUEUE]]) {
  test(`step 4d pins the lease-wait ${label}`, () => assert.match(step4d, rule));
}

test('step 5 points at step 4d for the hand-off limit instead of repeating it', () => {
  assert.match(blockingBullet, /Apply step 4d's hand-off limit and its lease-wait routing, with one `\/review-loop` invocation's PR set as the hand-off unit\./);
  assert.doesNotMatch(blockingBullet, /`recommendedHandoff` is `max/);
  assert.doesNotMatch(blockingBullet, /"Start anyway" for a hand-off/);
});

test('step 5 reads a lease give-up before it reads non-convergence as point B', () => {
  const at = (re) => blockingBullet.search(re);
  assert.ok(at(/orchestrator-stop: lease-wait/) >= 0, 'step 5 names the closing line');
  assert.ok(at(/orchestrator-stop: lease-wait/) < at(/does not converge/), 'the lease check comes first');
  assert.match(blockingBullet, /does not converge \(and its report does not end in the lease-wait line\)/);
});

test('step 4 documents recommendedHandoff in the preflight output', () => {
  const step4 = lines.find((l) => l.startsWith('**Resource preflight (beside'));
  assert.match(step4, /prints `\{ action, reason, level, capacity, step, sessions, live, recommendedParallel, recommendedHandoff \}`/);
});

const copies = {
  "SKILL.md's Implement block": block('### Implement (Sonnet, own worktree)'),
  "workflow.js's implementPrompt": workflow.split('function implementPrompt')[1].split('function reviewPathFor')[0],
};
for (const [name, text] of Object.entries(copies)) {
  test(`${name} maps the lease-wait give-up to status "error"`, () => assert.match(text, RETURN));
}

const reviewCopies = {
  "SKILL.md's Review block": [block('### Review (Opus, own worktree)'), CLOSING_LINE_RETURN],
  "workflow.js's reviewPrompt": [workflow.split('function reviewPrompt')[1], SCHEMA_RETURN],
};
for (const [name, [text, ret]] of Object.entries(reviewCopies)) {
  test(`${name} writes no file for a lease give-up`, () => assert.match(text, NO_REVIEW_FILE));
  test(`${name} returns the give-up in its own channel`, () => assert.match(text, ret));
  test(`${name} no longer maps the review give-up the Implement way`, () => assert.doesNotMatch(text, RETURN));
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
  ['Resource-stop route', /a ref stops for resources a second time in a run, whatever the pressure/, /the summed-wait counter, to 0, and that ref's stop count, after waiting 10 minutes/, /at `critical` a filtered re-run takes the engine row's override; below `critical` a plain resume or re-run, with no override and no `pressureOverride`/],
]) {
  test(`point F's table pins the ${label} row's three cells`, () => {
    const [, t, w, a] = row(label.replaceAll('\\', ''));
    assert.match(t, trigger);
    assert.match(w, wait);
    assert.match(a, anyway);
  });
}

test('step 4 hitl bullet and the preflight header point at the table', () => {
  const hitl = lines.find((l) => l.startsWith('- `action: "hitl"`') && l.includes('critical-hitl'));
  assert.ok(hitl, 'step 4 has an action: "hitl" bullet');
  assert.match(hitl, /per-step table in `references\/escalation-policy\.md`/);
  assert.match(read('scripts/resource-preflight.mjs'), /point F's per-step table in references\/escalation-policy\.md/);
});

test('the resource route caps a ref at two resource stops in a run, in SKILL.md and the policy', () => {
  const route = lines.find((l) => l.startsWith('  - `resource` —'));
  assert.ok(route, 'step 5 has a resource route');
  assert.match(route, /second resource stop in a run[^.]*point F whatever the pressure/);
  const stops = policy.slice(policy.indexOf('## Resource stops')).split(/\n## /)[0];
  assert.match(stops, /second resource stop in a run[^.]*point F whatever the pressure/);
  // A continuation agent's lease give-up is not an engine row, so the route must count it itself.
  for (const text of [route, stops]) assert.match(text, /continuation agent[^.]*`orchestrator-stop: lease-wait`[^.]*`notes: "lease-wait"`[^.]*counts as that ref's next resource stop/);
});

test('trigger 9 and the step 4 hitl bullet name the resource route', () => {
  assert.match(policy.split('\n').find((l) => l.startsWith('9. ')), /resource route/);
  assert.match(lines.find((l) => l.startsWith('- `action: "hitl"`') && l.includes('critical-hitl')), /step 5's `resource` route/);
});

test('step 4c sends a PR-less resource stop to the resource route, not point B', () => {
  assert.match(skill, /only a `failed`\/`blocked` row with \*\*no PR\*\* is an implement stall → \*\*HITL point B\*\* \(step 5\), unless the engine stopped it for resources/);
});

test('README mentions that review and fix fan-out is sized from lease capacity', () => {
  assert.match(read('README.md'), /[Rr]eview and fix hand-offs are sized from lease capacity/);
});

test("point F's wait and start-anyway bullets defer to the table", () => {
  const bullets = pointF.split('\n');
  const wait = bullets.find((l) => l.startsWith('- **wait**'));
  const anyway = bullets.find((l) => l.startsWith('- **start anyway**'));
  assert.match(wait, /"wait resets" column/);
  assert.match(anyway, /"Start anyway does" column/);
  assert.doesNotMatch(anyway, /for a command it runs the command with `CO_PRESSURE_OVERRIDE/);
});

test("step 6.2 says start anyway is a plain rerun below critical", () => {
  const step62 = lines.find((l) => l.startsWith('2. **If the rebase moved the base**'));
  assert.match(step62, /"start anyway" reruns with `CO_PRESSURE_OVERRIDE=critical-as-warning` as an inline prefix on that one command, never exported, when the pressure is `critical`, and plainly below it/);
});
