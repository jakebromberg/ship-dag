// The lease rules are pasted verbatim into engine and subagent prompts, so each
// copy has to carry every rule; SKILL.md step 4b has to open the gate, and the
// matcher that gate uses has to recognise every heavy command in the CI profiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
// workflow.js holds its prompts in template literals, so its backticks are escaped.
const unescaped = (src) => src.replaceAll('\\`', '`');
const skill = read('SKILL.md');
const block = (heading) => skill.split(heading)[1].split(/\n### |\n## /)[0];
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
const LIGHT = [
  /(^|\/|\s)ruff (check|format)/, // linters
  /^npm run format:check/, // prettier --check
  /^uv venv /, // creates an empty venv
  /^git submodule update /, // fetches a submodule checkout
  /^(rm|cp|find) /, // cache and build-dir housekeeping
  /^xcodegen generate/, // project generation, no build
  /^shellcheck /, // lints a few scripts
  /^(env -u \w+ )?python3 scripts\/test_/, // small script self-checks
  /^\.\/scripts\/bootstrap-/, // writes an xcconfig
  /^go generate /, // regenerates embedded trees
  /^status="\$\(git status /, // embed-tree sync check
  // code-audit-pipeline's shell self-tests of its queries and extractors: small
  // fixtures, but outside the matcher's `scripts/test*.sh` pattern.
  /^pipeline\/(queries\/)?_tests\/test_\w+\.sh$/,
  /^cd extractors\/swift \|\| exit 1; for t in tests\/\*\.sh;/,
];

test("claude-orchestrator's heavy-command matcher matches every heavy command in repo-ci-profiles.json", async () => {
  const co = process.env.CO_HOME || '/Users/me/Developer/claude-orchestrator';
  const { isHeavyCommand } = await import(resolve(co, 'dist/src/index.js'));
  const { profiles } = JSON.parse(read('references/repo-ci-profiles.json'));
  const missed = [];
  for (const [repo, { commands = [] }] of Object.entries(profiles)) {
    for (const cmd of commands) {
      if (!LIGHT.some((re) => re.test(cmd)) && !isHeavyCommand(cmd)) missed.push(`${repo}: ${cmd}`);
    }
  }
  assert.deepEqual(missed, []);
});
