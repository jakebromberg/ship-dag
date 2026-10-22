/**
 * The one rule for a structured telemetry finding: an object `{category: string|null, verdict: string|null, summary: string}`
 * (see `references/telemetry-schema.md`, "findings entries"). `normalizeRecord` refuses a findings entry that is neither a
 * string nor such an object, and `report()` counts by category only such objects. Any other object is legacy: readable, never counted.
 * @param {unknown} f a `findings` entry
 * @returns {boolean}
 */
export function isFindingObject(f) {
  const strOrNull = (v) => v === null || typeof v === 'string';
  return !!f && typeof f === 'object' && strOrNull(f.category) && strOrNull(f.verdict) && typeof f.summary === 'string';
}
