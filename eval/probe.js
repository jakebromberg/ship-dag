// probe.js — zero-agent Workflow probe. Run this BEFORE the eval harness to
// confirm the Workflow runtime actually exposes the globals the cost track
// depends on (`budget`, `log`). It spawns no agents, so it costs nothing.
//
// Run via the Workflow tool: Workflow({ scriptPath: '<abs>/eval/probe.js' }).
// Returns { hasBudget, hasLog, hasParallel, hasPipeline, spent } — if hasBudget
// is false, harness.js will record tokens:null for every stage and the cost
// track is unavailable (quality tracks still run).

export const meta = {
  name: 'ship-dag-eval-probe',
  description: 'Zero-agent probe: verify Workflow runtime globals (budget/log) before a costly eval run',
  phases: [{ title: 'Probe' }],
};

phase('Probe');

const hasBudget = typeof budget !== 'undefined' && budget !== null && typeof budget.spent === 'function';
const hasLog = typeof log === 'function';
const hasParallel = typeof parallel === 'function';
const hasPipeline = typeof pipeline === 'function';
const spent = hasBudget ? budget.spent() : null;

if (hasLog) log(`probe: budget=${hasBudget} log=${hasLog} parallel=${hasParallel} pipeline=${hasPipeline} spent=${spent}`);

return { hasBudget, hasLog, hasParallel, hasPipeline, spent };
