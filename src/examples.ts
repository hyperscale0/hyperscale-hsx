import type { HsxBase } from "./bases.ts";

/** Authored programs shipped with the compiler, generated from examples/*.hsx. */
export type HsxExample = HsxBase;
export { examples } from "./examples-bundle.ts";
