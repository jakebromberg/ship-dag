// The lease rules are pasted verbatim into engine and subagent prompts, so each
// copy has to carry every rule; SKILL.md step 4b has to open the gate, and the
// matcher that gate uses has to recognise every heavy command in the CI profiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCo } from './lib/co-home.mjs';
import { REPO_CI_COMMAND } from './lib/ci-profile.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
// workflow.js holds its prompts in template literals, so its backticks are escaped.
const unescaped = (src) => src.replaceAll('\\`', '`');
const skill = read('SKILL.md');
const block = (heading) => skill.split(heading)[1].split(/\n### |\n## /)[0];
// The three copies of the implement prompt, which share the rules below.
const implementCopies = ['prompt.md step 4', "SKILL.md's Implement block", "workflow.js's implementPrompt"];
const copies = {
  'prompt.md step 4': read('scripts/engine/prompt.md').split('\n').find((l) => l.startsWith('4. ')),
  "SKILL.md's Implement block": block('### Implement (Sonnet, own worktree)'),
  "SKILL.md's Review block": block('### Review (Opus, own worktree)'),
  "workflow.js's implementPrompt": unescaped(read('workflow.js')).split('function implementPrompt')[1].split('function reviewPathFor')[0],
  "workflow.js's reviewPrompt": unescaped(read('workflow.js')).split('function reviewPrompt')[1],
};

const rules = [
  /Heavy commands are leased machine-wide by a hook; one may wait several minutes before it starts, which is expected\./,
  /Run heavy commands in the foreground/,
  /A denial reading `lease: no slot after <n>s` means rerun the same command; it is never a test failure and never a reason to skip CI\./,
  /Claude Code prefixes the denial, so the tool result may read `PreToolUse:Bash hook error: lease: no slot after 450s …`; a tool result containing `lease: no slot after` anywhere, even one prefixed "hook error", means the lease is busy, not that the hook is broken, so rerun the same command\./,
  /Rerun once\. After the second `lease: no slot` denial in the session, whichever commands they hit, stop: comment on the issue, end your final message with the exact line `orchestrator-stop: lease-wait`, and exit without pushing\./,
  /Never wrap a command in `cli-lease\.js` yourself, and run `cli-lease\.js` or `run-ci-profile\.mjs` alone in its own Bash call\./,
];

for (const [name, text] of Object.entries(copies)) {
  for (const rule of rules) {
    test(`${name} pins the lease rule: ${rule.source.slice(0, 48)}…`, () => {
      assert.match(text, rule);
    });
  }
}

test('step 4b sets CO_LEASE_HOOK=on as an inline prefix on the engine run, not an export', () => {
  assert.match(skill, /`SHIP_DAG_CONFIG="\$STATE\/config\.json" SHIP_DAG_PROJECT_ROOT="\$PROJECT_ROOT" CO_HOME="\$CO" CO_LEASE_HOOK=on npx /);
  assert.doesNotMatch(skill, /export CO_LEASE_HOOK/);
});

test('both retry rules carve out lease reruns', () => {
  const carve = /rerunning after a `lease: no slot` denial is not an infra-failure retry; the two-denial give-up bounds it/;
  const lines = skill.split('\n');
  assert.match(lines.find((l) => l.startsWith('**Never loop-retry a failing CI or merge.**')), carve);
  assert.match(lines.find((l) => l.startsWith('- **No auto-retry loops**')), carve);
});

// Profile commands the matcher is right to leave alone: each is light, so a
// match here would only queue behind the lease for nothing. Anything heavy that
// the matcher misses must not be added here; it belongs in claude-orchestrator.
// A command is exempt only when every `&&` / `||` / `;` / `|` segment is light
// (or shell glue), so `rm -rf x && cargo nextest run` is still cross-checked.
const LIGHT = [
  /^(\S*\/)?ruff (check|format)\b/, // linters
  /^uv run --no-sync ruff (check|format)\b/,
  /^npm run format:check\b/, // prettier --check
  /^uv venv /, // creates an empty venv
  /^git submodule update /, // fetches a submodule checkout
  /^(rm|cp|find) /, // cache and build-dir housekeeping
  /^xcodegen generate\b/, // project generation, no build
  /^shellcheck /, // lints a few scripts
  /^(env -u \w+ )?python3 scripts\/test_\w+\.py$/, // small script self-checks
  /^\.\/scripts\/bootstrap-[\w-]+\.sh$/, // writes an xcconfig
  /^go generate /, // regenerates embedded trees
  // Backend-Service's bare static checks (BS#2591): each reads source files and
  // exits, under a second apiece, with no build, install, or network. Named one
  // by one so a future heavy check script still meets the cross-check.
  /^scripts\/check-(cross-cache-identity-flags|precondition-guards)\.sh$/,
  /^node scripts\/check-(legacy-entry-id-writes|lml-caller-classification|auth-tables-doc|sql-claim-docs)\.mjs$/,
  /^node scripts\/check-bulk-update-analyze\.mjs --strict$/,
  // code-audit-pipeline's shell self-tests of its queries and extractors: small
  // fixtures, but outside the matcher's `scripts/test*.sh` pattern.
  /^pipeline\/(queries\/)?_tests\/test_\w+\.sh$/,
];
// Whole-command exemptions for multi-statement shell that segment splitting cannot parse.
const LIGHT_WHOLE = [
  /^status="\$\(git status [^;&|]*\)"; if \[ -n "\$status" \]; then echo [^;]*; echo "\$status" >&2; exit 1; fi$/, // embed-tree sync check
  /^cd extractors\/swift \|\| exit 1; for t in tests\/\*\.sh; do echo "--- \$t"; "\$t" >\/dev\/null \|\| exit 1; done$/,
];
const GLUE = /^(true|exit \d+|sleep \d+|\{|\{ sleep \d+|\}|)$/;
const segments = (cmd) => cmd.split(/&&|\|\||[;|\n]/).map((x) => x.trim());
export const isLight = (cmd) =>
  LIGHT_WHOLE.some((re) => re.test(cmd)) ||
  segments(cmd).every((seg) => GLUE.test(seg) || LIGHT.some((re) => re.test(seg.replace(/^\{ /, ''))));

test('a compound command is exempt only when every segment is light', () => {
  for (const cmd of [
    'rm -rf x && cargo nextest run',
    'uv run --no-sync ruff check . && bundle exec rspec',
    'ruff check . ; swift test',
    'cp a b || true; npm test',
  ]) assert.equal(isLight(cmd), false, cmd);
  for (const cmd of ['rm -rf x && cp a b', 'ruff check . && cp a b || true', 'rm -rf DerivedData || { sleep 5; rm -rf DerivedData; }']) {
    assert.equal(isLight(cmd), true, cmd);
  }
});

test("claude-orchestrator's heavy-command matcher matches every heavy command in repo-ci-profiles.json", async () => {
  const { isHeavyCommand } = await importCo(process.env, ['isHeavyCommand']);
  const { profiles } = JSON.parse(read('references/repo-ci-profiles.json'));
  const missed = [];
  for (const [repo, { commands = [] }] of Object.entries(profiles)) {
    for (const cmd of commands) {
      if (!isLight(cmd) && !isHeavyCommand(cmd)) missed.push(`${repo}: ${cmd}`);
    }
  }
  assert.deepEqual(missed, []);
});

test("claude-orchestrator's heavy-command matcher matches a repo's declared scripts/ci", async () => {
  const { isHeavyCommand } = await importCo(process.env, ['isHeavyCommand']);
  assert.equal(isHeavyCommand(REPO_CI_COMMAND), true);
});

// Implementers run local CI themselves before pushing, so each implement copy points them at a repo's declared
// scripts/ci, run directly (the matcher reads `sh scripts/ci` as `sh` and would not lease it).
const declaredCi = /When the repo has an executable `scripts\/ci`, run it as `scripts\/ci` \(not `sh scripts\/ci`\): it is the repo's declared local CI\./;
for (const name of implementCopies) {
  test(`${name} points implementers at a repo's declared scripts/ci`, () => {
    assert.match(copies[name], declaredCi);
  });
}

// Long commands stay in the foreground with an explicit timeout, and engine sessions never drive a browser.
const foregroundRules = [
  'Run long commands in the foreground with an explicit timeout** (Bash `timeout` parameter, up to 600000 ms) — a command that outlives the default foreground window gets auto-backgrounded, and **ending your turn to "wait for the notification" ends your session**: the orchestrator treats a returned turn as completion and reaps you, stranding uncommitted work in the worktree. If something does land in the background, poll it to completion (TaskOutput) within the same turn; never end a turn while a test run, install, or push is still pending.',
  '**Never launch or drive a browser** — no Playwright/e2e runs (headed or headless), no `gh … --web`, no `open <url>`, no browser tools: browser windows disrupt the machine\'s human user, and e2e suites are out of scope for engine sessions. Verification is terminal-only; if a check seems to need a browser, note it as unverified instead.',
];
for (const name of implementCopies) {
  test(`${name} carries the foreground-timeout and no-browser rules after the lease rules`, () => {
    for (const rule of foregroundRules) assert.ok(copies[name].includes(rule), rule.slice(0, 40));
    assert.ok(copies[name].includes(`alone in its own Bash call. **${foregroundRules[0]} ${foregroundRules[1]}`));
  });
}

// Review blocks on the same three test gaps again and again, so the engine and inline implement copies both carry the pre-push checklist.
const checklist = [
  /every acceptance criterion and every settled decision has a test/,
  /every failure path and boundary has a test/,
  /revert the line under test, see the test fail, then restore it/,
  /name any test you could not make fail in the PR body/,
  /state in the PR body how each acceptance criterion is tested/,
];
for (const name of ['prompt.md step 3', "SKILL.md's Implement block", "workflow.js's implementPrompt"]) {
  const text = name === 'prompt.md step 3'
    ? read('scripts/engine/prompt.md').split('\n').find((l) => l.startsWith('3. '))
    : copies[name];
  test(`${name} carries the pre-push test checklist`, () => {
    for (const rule of checklist) assert.match(text, rule);
  });
}

// Triage's settled decisions reach every implement path, in the engine's wording (emit-config's withDecisions).
// workflow.js has no imports, so its copy of the rendering is pinned to withDecisions here.
const { withDecisions } = await import('./emit-config.mjs');
const DECISIONS_HEADING = 'Settled decisions (binding; they override the issue body where they differ):';
const promptFrom = (src) => new Function('repo', `${src.split('function decisionLines')[1].split('function reviewPathFor')[0].replace(/^/, 'function decisionLines')}\nreturn implementPrompt`)('o/r');
const implementPrompt = promptFrom(read('workflow.js'));
// The prompt as it was before decisions existed: the same source with the decisions spread taken out.
const spread = '    ...decisionLines(iss.decisions),\n';
const promptWithoutDecisions = promptFrom(read('workflow.js').replace(spread, ''));

test("SKILL.md's Implement block has a {DECISIONS} slot beside {DIGEST}", () => {
  assert.match(copies["SKILL.md's Implement block"], /\{DIGEST\}[\s\S]*\{DECISIONS\}/);
});

test("SKILL.md's {DECISIONS} fill rule sits in the step text, outside the verbatim block, with withDecisions' heading", () => {
  assert.ok(!copies["SKILL.md's Implement block"].includes('fill from triage'));
  assert.ok(skill.split('### Implement (Sonnet, own worktree)')[0].includes(`\`{DECISIONS}\` with the line \`${DECISIONS_HEADING}\``));
});

test("SKILL.md's Workflow call passes each issue's decisions", () => {
  assert.match(skill, /issues: \[\{ number, digest, decisions,/);
});

test("workflow.js's implementPrompt renders decisions exactly as withDecisions does", () => {
  const decisions = ['use JSONL', 'keep\nthe seam'];
  const rendered = withDecisions('', decisions).trimStart();
  assert.ok(rendered.startsWith(DECISIONS_HEADING));
  assert.ok(implementPrompt({ number: 1, digest: 'd', decisions }).includes(`\n\n${rendered}\n`));
  assert.match(implementPrompt({ number: 1, digest: 'd', decisions: ['use JSONL'] }), /\n- use JSONL\n/);
});

test("workflow.js's implementPrompt skips non-string decisions instead of throwing", () => {
  assert.equal(implementPrompt({ number: 1, digest: 'd', decisions: [7, null, { a: 1 }, 'use JSONL'] }), implementPrompt({ number: 1, digest: 'd', decisions: ['use JSONL'] }));
  assert.equal(implementPrompt({ number: 1, digest: 'd', decisions: [7, null] }), promptWithoutDecisions({ number: 1, digest: 'd' }));
});

test('the baseline prompt is built from a source that differs from workflow.js', () => {
  assert.ok(read('workflow.js').includes(spread));
});

for (const decisions of [undefined, null, [], ['', '  ', '\n']]) {
  test(`workflow.js's implementPrompt is unchanged for decisions ${JSON.stringify(decisions)}`, () => {
    const prompt = implementPrompt({ number: 1, digest: 'd', decisions });
    assert.equal(prompt, promptWithoutDecisions({ number: 1, digest: 'd' }));
    assert.ok(prompt.includes('Issue digest (from triage): d\n\nSteps:\n'));
  });
}

// Two rules from blocking reviews: a changed instruction left stale in another copy, and fakes that differ from the real CLI.
const testFirstRules = [
  'Before you commit, find every other copy of an instruction, field list or contract you changed and update each one in this PR; that is scope, not a drive-by. Search for the old wording and the changed symbol in SKILL.md, `workflow.js`, `scripts/engine/prompt.md`, README, `references/`, served API mirrors, registries, ADRs and doc comments. If copies are meant to stay in sync, add or extend a test that compares them. List what you updated on a `Mirrors:` line in the PR body, or write `Mirrors: none found`.',
  'When code drives `gh` or another CLI, build each fake from one recorded real response per call shape (read-only commands only), kept as a fixture; a fake must never return a shape the real tool does not produce.',
];
for (const name of implementCopies) {
  const text = name === 'prompt.md step 4'
    ? read('scripts/engine/prompt.md').split('\n').find((l) => l.startsWith('3. '))
    : copies[name];
  test(`${name} carries the every-copy and recorded-fake rules in its test-first step, ahead of the lease rules`, () => {
    for (const rule of testFirstRules) assert.ok(text.includes(rule), rule.slice(0, 40));
    const lease = text.indexOf('Heavy commands are leased');
    assert.ok(lease === -1 || text.indexOf(testFirstRules[0]) < lease);
    assert.ok(text.includes(`${testFirstRules[0]} ${testFirstRules[1]}`));
  });
}
