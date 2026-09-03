/**
 * The `hsx` command line over the one compiler entry point and catalog.
 *
 * `check` prints diagnostics and says nothing else; `build` writes the
 * compiled artifacts as JSON. Neither reads the environment, neither touches
 * a network, and neither writes outside the path the caller names.
 *
 * Everything here is a pure function of `argv` plus the injected `Io`, so the
 * spec drives the real code paths with an in-memory filesystem instead of
 * asserting on a subprocess's scrollback.
 */

import { fileURLToPath } from "node:url";
import { compile, type CompileResult } from "./compile.ts";
import type { UdlCostManifest, UdlCostTable } from "./cost.ts";
import { hsxDiagnostics } from "./diagnostics.ts";
import { format } from "./format.ts";
import { HSX_TARGET_UDL_VERSION, HSX_VERSION } from "./version.ts";

/** Filesystem and streams, injected so the CLI stays testable. */
export interface Io {
  readonly err: (line: string) => void;
  readonly out: (line: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
}

/**
 * Exit codes. `warning` exits 0 because a lint note is not a failure; pass
 * `--strict` to make it one.
 */
const OK = 0;
const REFUSED = 1;
const USAGE = 2;

export const USAGE_TEXT = `hsx ${HSX_VERSION}, the HSX compiler

Usage:
  hsx check <file.hsx> [--strict]
  hsx build <file.hsx> [--out <file.json>] [--strict]
  hsx cost <file.hsx> [--json] [--out <file.json>] [--strict]
  hsx explain <HSX####>
  hsx format <file.hsx>
  hsx --version
  hsx --help

Commands:
  check   Compile and report diagnostics. Prints nothing when the program is clean.
  build   Compile and write canonical UDL and its Business Frame as JSON.
  cost    Compile and print the version-pinned cost manifest as a table or JSON.
  explain Print one diagnostic title, fix, and source example.
  format  Print the source in the one canonical HSX style.

Options:
  --json        Print the cost manifest as JSON instead of a table.
  --out <file>  Write build or cost JSON to this path instead of stdout.
  --strict      Treat warning-severity diagnostics as failures.

Exit codes:
  0  the program compiled (verdict valid, or warning without --strict)
  1  the program was refused (verdict invalid, or warning with --strict)
  2  the command line or the input file could not be used`;

export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    io.out(USAGE_TEXT);
    return command === undefined ? USAGE : OK;
  }
  if (command === "--version" || command === "-v") {
    io.out(`${HSX_VERSION} (UDL version ${HSX_TARGET_UDL_VERSION})`);
    return OK;
  }
  if (command === "explain") return explainDiagnostic(rest, io);
  if (
    command !== "check" &&
    command !== "build" &&
    command !== "cost" &&
    command !== "format"
  ) {
    io.err(`hsx: unknown command "${command}"`);
    io.err(USAGE_TEXT);
    return USAGE;
  }

  const parsed = parseOptions(rest, command);
  if ("error" in parsed) {
    io.err(`hsx: ${parsed.error}`);
    return USAGE;
  }

  let source: string;
  try {
    source = await io.readFile(parsed.file);
  } catch (cause) {
    io.err(`hsx: cannot read ${parsed.file}: ${messageOf(cause)}`);
    return USAGE;
  }

  if (command === "format") {
    const result = format(source);
    if (!result.ok) {
      for (const diagnostic of result.diagnostics) {
        io.err(`${parsed.file}:1:1: error [parse] ${diagnostic.message}`);
      }
      return REFUSED;
    }
    io.out(result.formatted.trimEnd());
    return OK;
  }

  let costTable: UdlCostTable;
  try {
    costTable = await readDefaultCostTable(io);
  } catch (cause) {
    io.err(`hsx: cannot read the packaged cost table: ${messageOf(cause)}`);
    return USAGE;
  }
  const result = compile(source, { costTable });
  for (const line of diagnosticLines(parsed.file, result)) io.err(line);

  const refused =
    result.verdict === "invalid" ||
    (parsed.strict && result.verdict === "warning");

  if (command === "check") {
    return refused ? REFUSED : OK;
  }

  if (!result.artifacts) return REFUSED;
  if (command === "cost") {
    const json = `${JSON.stringify(result.artifacts.costManifest, null, 2)}\n`;
    if (parsed.out !== undefined) {
      const writeCode = await writeOutput(parsed.out, json, io);
      return writeCode === OK && refused ? REFUSED : writeCode;
    }
    io.out(
      parsed.json
        ? json.trimEnd()
        : renderCostTable(result.artifacts.costManifest),
    );
    return refused ? REFUSED : OK;
  }
  const json = `${JSON.stringify(
    {
      document: result.artifacts.document,
      frame: result.artifacts.frame,
    },
    null,
    2,
  )}\n`;
  if (parsed.out === undefined) {
    io.out(json.trimEnd());
  } else {
    try {
      await io.writeFile(parsed.out, json);
    } catch (cause) {
      io.err(`hsx: cannot write ${parsed.out}: ${messageOf(cause)}`);
      return USAGE;
    }
  }
  return refused ? REFUSED : OK;
}

interface Options {
  readonly file: string;
  readonly json: boolean;
  readonly out?: string;
  readonly strict: boolean;
}

function parseOptions(
  args: readonly string[],
  command: "build" | "check" | "cost" | "format",
): Options | { readonly error: string } {
  let file: string | undefined;
  let json = false;
  let out: string | undefined;
  let strict = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--strict") {
      if (command === "format") {
        return { error: "hsx format has no style options" };
      }
      strict = true;
      continue;
    }
    if (argument === "--json") {
      if (command !== "cost") return { error: "--json belongs to hsx cost" };
      json = true;
      continue;
    }
    if (argument === "--out") {
      if (command !== "build" && command !== "cost") {
        return { error: "--out belongs to hsx build or hsx cost" };
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: "--out needs a file path" };
      }
      out = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      return { error: `unknown option "${argument}"` };
    }
    if (file !== undefined) {
      return { error: `hsx ${command} takes one file, got "${argument}" too` };
    }
    file = argument;
  }

  if (file === undefined) return { error: `hsx ${command} needs a file` };
  return { file, json, ...(out === undefined ? {} : { out }), strict };
}

function explainDiagnostic(args: readonly string[], io: Io): number {
  if (args.length !== 1 || args[0]?.startsWith("-")) {
    io.err("hsx: explain needs one diagnostic code");
    return USAGE;
  }
  const diagnostic = hsxDiagnostics.find(({ code }) => code === args[0]);
  if (!diagnostic) {
    io.err(`hsx: unknown diagnostic code ${args[0]}`);
    return USAGE;
  }
  io.out(
    [
      `${diagnostic.code} ${diagnostic.title}`,
      `Stage: ${diagnostic.stage}`,
      `Fix: ${diagnostic.fix}`,
      diagnostic.example === null
        ? "Example: unavailable from source alone"
        : `Example:\n${diagnostic.example}`,
    ].join("\n"),
  );
  return OK;
}

function renderCostTable(manifest: UdlCostManifest): string {
  const rows = [
    `costTableVersion\t${manifest.costTableVersion}`,
    "instrument.action\teffect\tunit\tcount\ttotal\tpayer",
  ];
  for (const action of manifest.actions) {
    for (const component of action.components) {
      const fixed = BigInt(component.perEventMinor) * BigInt(component.count);
      const unit = [
        `${component.perEventMinor} ${manifest.currency} minor`,
        component.bps > 0 ? `${component.bps} bps` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" + ");
      const total =
        component.bps === 0
          ? `${fixed} ${manifest.currency} minor`
          : [
              fixed === 0n ? undefined : `${fixed} ${manifest.currency} minor`,
              `amount-dependent (${component.bps} bps)`,
            ]
              .filter((part): part is string => part !== undefined)
              .join(" + ");
      rows.push(
        [
          `${action.instrument}.${action.action}`,
          component.signature,
          unit,
          component.count,
          total,
          component.payer,
        ].join("\t"),
      );
    }
  }
  return rows.join("\n");
}

async function writeOutput(
  path: string,
  contents: string,
  io: Io,
): Promise<number> {
  try {
    await io.writeFile(path, contents);
  } catch (cause) {
    io.err(`hsx: cannot write ${path}: ${messageOf(cause)}`);
    return USAGE;
  }
  return OK;
}

async function readDefaultCostTable(io: Io): Promise<UdlCostTable> {
  const candidates = [
    fileURLToPath(new URL("../examples/cost-table.json", import.meta.url)),
    fileURLToPath(new URL("../../examples/cost-table.json", import.meta.url)),
  ];
  let lastError: unknown;
  for (const path of candidates) {
    try {
      return JSON.parse(await io.readFile(path)) as UdlCostTable;
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError;
}

/** `file:line:col: severity [stage] message`, the shape editors already parse. */
function diagnosticLines(
  file: string,
  result: CompileResult,
): readonly string[] {
  return result.diagnostics.map(
    (diagnostic) =>
      `${diagnostic.file ?? file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.severity} [${diagnostic.stage}] ${diagnostic.message}`,
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
