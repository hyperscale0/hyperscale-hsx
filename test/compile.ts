import costTableJson from "../examples/cost-table.json";
import {
  compile as compileHsx,
  type CompileOptions,
  type UdlCostTable,
} from "../src/index.ts";

export const testCostTable = costTableJson as UdlCostTable;

export function compile(source: string, options: CompileOptions = {}) {
  return compileHsx(source, { costTable: testCostTable, ...options });
}
