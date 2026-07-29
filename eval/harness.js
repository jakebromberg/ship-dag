// harness.js — Workflow driver that replays a frozen corpus through ONE
// model-assignment variant and returns RAW per-issue results for offline scoring
// by eval/score.mjs. This file is written to be RUN, but running it is a
// cost-gated, user-invoked action (it spawns real implement/review agents against
// real repos): Workflow({ scriptPath: '<abs>/eval/harness.js', args: {...} }).
// Run eval/probe.js first to confirm the budget/log globals exist.
//
// DESIGN NOTES (why it looks the way it does):
//   * Workflow scripts cannot import — so all scoring math lives in eval/lib/*
//     and runs OFFLINE on this script's return value; here we only collect raw
//     data. Review-recall no longer SEEDS mutants in-run: it consumes the frozen
//     eval/mutant-bank.json (built once by eval/build-mutant-bank.mjs), so every
//     variant judges byte-identical, test-gated diffs (paired recall) and the
//     Haiku seed agent is gone from the hot path.
//   * SERIAL (for…await), never parallel: budget.spent() is a single shared
//     cumulative counter, so a stage's output-token cost is only recoverable as
//     the delta across its one awaited agent with nothing else running. (Caveat:
//     if the main loop spends concurrently while this runs, deltas over-count;
//     treat cost as indicative and re-confirm on a quiet session.)
//   * Every agent works in a DISPOSABLE clone and is told, redundantly, NEVER to
//     push, open a PR, or write to any real remote. This is an offline replay of
//     already-merged history; it must leave no outward trace.
//
// args: {
//   runId:   string,                    // names the persisted scorecard; must be unique
//   variant: string,                    // label only (e.g. 'current')
//   spec:    { triage:{model,effort}, implement:{model,effort}, review:{model,effort} },
//   entries: [ { repo, issue, pr, baseSha, mergeSha, tier } ... ], // a corpus.json subset
//   bank:    [ { repo, issue, tier, kind, ordinal, diff, testStatus, bucket ... } ], // mutant-bank.json .mutants
//   workdirBase?: string,               // default '/tmp/ship-dag-eval'
//   prices?:  { haiku, sonnet, opus },  // omit to score with placeholder prices
// }

export const meta = {
  name: 'ship-dag-eval-harness',
  description: 'Replay a frozen corpus through one model-assignment variant in disposable sandboxes (never pushes) and return raw per-issue results for offline scoring',
  phases: [
    { title: 'Triage' },
    { title: 'Implement' },
    { title: 'Yield' },
    { title: 'Recall' },
  ],
};

// The Workflow tool may hand `args` to the script as a parsed object OR as a
// JSON string (the resume/recovery path stringifies it) — accept either.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {});
const {
  runId,
  variant,
  spec,
  entries = [],
  bank = [],
  workdirBase = '/tmp/ship-dag-eval',
  prices = null,
} = A;

if (!runId || !spec) throw new Error('harness args require { runId, spec, entries }');

const HAS_BUDGET = typeof budget !== 'undefined' && budget !== null && typeof budget.spent === 'function';
const spend = () => (HAS_BUDGET ? budget.spent() : null);
const delta = (before) => (before == null ? null : spend() - before);
const note = (msg) => { if (typeof log === 'function') log(msg); };

const NEVER = 'CRITICAL SAFETY: work ONLY inside the given disposable local clone. NEVER run `git push`, NEVER open a PR, NEVER write to origin or any real remote. This is an offline replay of already-merged history — leave no outward trace.';

const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['complexity'],
  properties: {
    routing: { type: ['string', 'null'], enum: ['clear', 'needs-decision', null] },
    complexity: { type: 'string', enum: ['mechanical', 'normal', 'complex'] },
    rationale: { type: 'string' },
  },
  additionalProperties: true,
};
const FILESET_SCHEMA = {
  type: 'object',
  required: ['predFiles', 'goldFiles'],
  properties: {
    predFiles: { type: 'array', items: { type: 'string' } },
    goldFiles: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: true,
};
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'bounced'],
  properties: {
    verdict: { type: ['string', 'null'], enum: ['merged', 'blocked', null] },
    bounced: { type: 'boolean' },
  },
  additionalProperties: true,
};
const CATCH_SCHEMA = {
  type: 'object',
  required: ['caught'],
  properties: { caught: { type: 'boolean' }, note: { type: 'string' } },
  additionalProperties: true,
};

const results = [];

for (let i = 0; i < entries.length; i += 1) {
  const e = entries[i];
  const tag = `${e.repo}#${e.issue}`;
  const sandbox = `${workdirBase}/${runId}/${i}`;
  const tokens = { triage: null, implement: null, review: null };

  // --- Triage: from the ISSUE TEXT ALONE, predict routing + complexity. ---
  // Scored (open-loop) against the realized corpus tier; does NOT re-route the
  // implement stage — spec.implement stays fixed per variant, so triage quality
  // and cost are measured in isolation.
  phase('Triage');
  const tTri = spend();
  const tri = await agent(
    `${NEVER}\n\nRead ONLY the issue — do NOT look at any diff, branch, or the merged PR: \`gh issue view ${e.issue} --repo ${e.repo}\`. As a triage step decide, from the issue text alone: routing='clear' if work can start without a human decision, 'needs-decision' if it needs clarification or a product call first; complexity='mechanical' (trivial: single-file/config/string/dep bump, no logic), 'normal', or 'complex' (multi-file, algorithmic, concurrency, schema/migration, security surface, or public-API). Report { routing, complexity, rationale (one line) }.`,
    { label: `triage:${tag}`, phase: 'Triage', model: spec.triage.model, effort: spec.triage.effort, schema: TRIAGE_SCHEMA },
  );
  tokens.triage = delta(tTri);
  const triage = tri ? { routing: tri.routing ?? null, complexity: tri.complexity ?? null, rationale: tri.rationale } : null;

  // --- Implement track: cold-start the issue from baseSha, capture the file set. ---
  phase('Implement');
  const t0 = spend();
  const impl = await agent(
    `${NEVER}\n\nClone ${e.repo} into ${sandbox}/impl and hard-reset to ${e.baseSha} (the state before the fix landed). Read the issue: \`gh issue view ${e.issue} --repo ${e.repo}\`. Implement exactly what the issue asks — no more. Then report two file lists as JSON:\n- predFiles: the files you changed — \`git -C ${sandbox}/impl diff --name-only\`\n- goldFiles: the known-good PR's OWN changed files — \`gh pr view ${e.pr} --repo ${e.repo} --json files -q '.files[].path'\` (do NOT diff a baseSha..mergeSha range — it sweeps in unrelated commits that landed while the PR was open)\``,
    { label: `impl:${tag}`, phase: 'Implement', model: spec.implement.model, effort: spec.implement.effort, schema: FILESET_SCHEMA },
  );
  tokens.implement = delta(t0);
  const implement = impl ? { predFiles: impl.predFiles || [], goldFiles: impl.goldFiles || [] } : null;

  // --- First-pass yield: a fresh review agent self-labels the implementation. ---
  phase('Yield');
  const t1 = spend();
  const fp = impl
    ? await agent(
        `${NEVER}\n\nA developer implemented issue #${e.issue} of ${e.repo} in ${sandbox}/impl. Review the working-tree diff: \`git -C ${sandbox}/impl diff\`. Would this merge as-is under a normal review gate? Return verdict='merged' if yes, 'blocked' if it needs changes, and bounced=true whenever you would request changes.`,
        { label: `yield:${tag}`, phase: 'Yield', model: spec.review.model, effort: spec.review.effort, schema: VERDICT_SCHEMA },
      )
    : null;
  tokens.review = delta(t1);
  const firstPass = fp ? { verdict: fp.verdict ?? null, bounced: !!fp.bounced } : null;

  // --- Review recall: judge this issue's FROZEN, test-gated mutants (bank). ---
  // No seeding: every variant judges the byte-identical diffs from the bank, so
  // recall is paired. Each mutant already passed the test-failure gate offline,
  // so a miss here is a genuine review miss, not equivalent-mutant noise.
  phase('Recall');
  const mutants = [];
  const issueBank = bank.filter((m) => m.repo === e.repo && String(m.issue) === String(e.issue));
  for (const bm of issueBank) {
    const t2 = spend();
    const judged = await agent(
      `${NEVER}\n\nReview this one-change diff from ${bm.repo} (${bm.file}) for defects. Report caught=true ONLY if you identify a concrete behavior-changing defect in the changed line(s), caught=false otherwise. You are NOT told whether any defect exists.\n\n\`\`\`diff\n${bm.diff || ''}\n\`\`\``,
      { label: `judge:${tag}:${bm.kind}:${bm.ordinal}`, phase: 'Recall', model: spec.review.model, effort: spec.review.effort, schema: CATCH_SCHEMA },
    );
    const d = delta(t2);
    tokens.review = tokens.review == null ? d : tokens.review + (d || 0);
    // Thread tier + gate bucket onto the mutant so the scorer can split recall by
    // tier and by gated/parse-only (the harness no longer re-derives validity).
    mutants.push({
      id: `${bm.kind}:${bm.ordinal}`,
      kind: bm.kind,
      tier: bm.tier ?? e.tier,
      testStatus: bm.testStatus,
      bucket: bm.bucket,
      valid: true,
      caught: !!(judged && judged.caught),
      defect: bm.defect,
      file: bm.file,
    });
  }

  results.push({ repo: e.repo, issue: e.issue, tier: e.tier, triage, implement, firstPass, review: { mutants }, tokens });
  note(`${tag}: triage=${triage ? triage.complexity : '—'} impl=${implement ? 'ok' : '—'} yield=${firstPass ? firstPass.verdict : '—'} mutants=${mutants.length}`);
}

// Raw data only — feed stdout to `node eval/score.mjs -` for the scorecard.
return { runId, variant, spec, prices, results };
