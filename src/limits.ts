/**
 * What the compiler refuses to read, as opposed to what it refuses to emit.
 * `MONEY_EVENT_BUDGET` in lower.ts bounds the OUTPUT; these bound the INPUT,
 * which is the side an attacker controls.
 *
 * Both numbers are set against the 34 real programs this compiler is tested
 * on. The deepest nests 5 levels; the largest is 13,934 bytes.
 */
export const HSX_LIMITS = Object.freeze({
  /**
   * How deep the recursive-descent productions may nest. Measured on this
   * machine, the parser exhausted the call stack at 9,217 nested blocks and
   * threw a RangeError out of `compile`, which SECURITY.md promises never
   * happens. The crash point moves with whatever stack the process has left,
   * so the ceiling is declared here instead of discovered at runtime. 64 is
   * 12x the deepest real program and 144x below that measured crash.
   */
  maxNestingDepth: 64,
  /** Matches `UDL_LIMITS.maxSourceBytes`. 18x the largest real program. */
  maxSourceBytes: 256 * 1_024,
});
