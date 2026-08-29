export { checkProgram } from "./check.ts";
export { compile } from "./compile.ts";
export {
  overrideProgramEntries,
  type ProgramEntryOverride,
  type ProgramEntryOverrideIssue,
  type ProgramEntryOverrideValue,
} from "./entry-overrides.ts";
export { lowerProgram, MONEY_EVENT_BUDGET } from "./lower.ts";
export { parseProgram } from "./parse.ts";
export type { Program } from "./ast.ts";
