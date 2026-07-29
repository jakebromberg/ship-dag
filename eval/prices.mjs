// prices.mjs — output-token prices for the cost track.
//
// USD per 1,000,000 OUTPUT tokens, from Anthropic's published pricing as of
// 2026-07: Opus 4.8 $25, Sonnet 5 $15 (a $10 intro rate runs through
// 2026-08-31), Haiku 4.5 $5. Output dominates model cost and is the only figure
// the Workflow `budget.spent()` delta exposes, so the harness attributes cost as
// output-tokens × these rates. Re-verify against current published prices before
// trusting any $ figure the harness prints.
// Run tests: node --test "skills/ship-dag/eval/**/*.test.mjs"

export const OUTPUT_USD_PER_MTOK = {
  haiku: 5,
  sonnet: 15,
  opus: 25,
};

/**
 * Cost in USD of `outputTokens` produced by `model`.
 * @param {string} model  one of the keys in the price table
 * @param {number} outputTokens
 * @param {Record<string, number>} [table]
 * @returns {number}
 */
export function costUSD(model, outputTokens, table = OUTPUT_USD_PER_MTOK) {
  const rate = table[model];
  if (rate === undefined) throw new Error(`no price for model: ${model}`);
  return (rate * outputTokens) / 1e6;
}
