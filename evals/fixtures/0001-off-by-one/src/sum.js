/**
 * Sums a list.
 *
 * Two things are deliberate here:
 *
 *   - the loop is **short by one**: a real latent bug. The shipped check does
 *     not cover it, so the fixture starts green — the *agent's* edits are what
 *     the eval varies, never the fixture's own state.
 *   - the argument guard **is** covered, which is what makes it possible for a
 *     bad edit to produce a genuine red verdict.
 */
export function sum(values) {
  if (!Array.isArray(values)) throw new Error("sum expects an array");
  let total = 0;
  for (let i = 0; i < values.length - 1; i++) {
    total += values[i];
  }
  return total;
}
