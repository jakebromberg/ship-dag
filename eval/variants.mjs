// variants.mjs — the model-assignment vectors the harness replays and compares.
//
// Each variant assigns { model, effort } to the three stages. `current` is the
// shipped Haiku/Sonnet/Opus default; `ceiling` and `floor` bracket it; the
// single-stage swaps isolate one lever so a quality/cost delta can be pinned to
// a specific stage.
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

const S = (model, effort) => ({ model, effort });

export const VARIANTS = {
  // Shipped default.
  current: { triage: S('haiku', 'low'), implement: S('sonnet', 'medium'), review: S('opus', 'high') },
  // Quality ceiling — everything on the strongest model.
  ceiling: { triage: S('opus', 'high'), implement: S('opus', 'high'), review: S('opus', 'high') },
  // Cost floor — keep the already-cheapest Haiku triage, downgrade the expensive
  // review stage to Sonnet and implement to low effort.
  floor: { triage: S('haiku', 'low'), implement: S('sonnet', 'low'), review: S('sonnet', 'high') },
  // Single-stage swaps off `current` to isolate one lever.
  'opus-triage': { triage: S('opus', 'high'), implement: S('sonnet', 'medium'), review: S('opus', 'high') },
  'sonnet-review': { triage: S('haiku', 'low'), implement: S('sonnet', 'medium'), review: S('sonnet', 'high') },
};

export const STAGES = ['triage', 'implement', 'review'];

/**
 * Resolve a variant by name, throwing on an unknown name (with the valid set).
 * @param {string} name
 * @returns {{triage:{model:string,effort:string}, implement:object, review:object}}
 */
export function resolveVariant(name) {
  const v = VARIANTS[name];
  if (!v) throw new Error(`unknown variant: ${name} (have: ${Object.keys(VARIANTS).join(', ')})`);
  return v;
}
