import costTableJson from "../examples/cost-table.json";
import {
  compile as compileHsx,
  type CompileOptions,
  type UdlCostTable,
} from "../src/index.ts";

/** The packaged rate cards, one per priced currency; SAR first. */
export const testCostTables = costTableJson as readonly UdlCostTable[];
export const testCostTable = testCostTables[0]!;

export function compile(source: string, options: CompileOptions = {}) {
  return compileHsx(source, { costTable: testCostTables, ...options });
}
