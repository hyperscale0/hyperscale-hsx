/** Authored programs shipped with the compiler, generated from examples/*.hsx. */
export interface HsxExample {
  id: string;
  title: string;
  summary: string;
  headers: string[];
  source: string;
}
export { examples } from "./examples-bundle.ts";
