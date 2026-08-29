/**
 * The two versions HSX carries, and the difference between them.
 *
 * `HSX_VERSION` is the npm package's semver: it moves when this compiler's
 * code changes, including changes that only affect diagnostics or docs.
 *
 * `HSX_IR_VERSION` is the format number stamped into every compiled document
 * as its `hsx` field. It moves only when the emitted IR shape changes in a
 * way a consumer must notice, so a runtime can refuse a document it does not
 * understand by reading one integer. A package release almost never bumps it.
 */

/** Stamped into every compiled HSX-JSON document as `hsx`. */
export const HSX_IR_VERSION = 1;

/** Kept equal to the package.json version by `test/spec.spec.ts`. */
export const HSX_VERSION = "1.0.0-alpha.6";
