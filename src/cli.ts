/**
 * The `hsx` command line: two subcommands over the one compiler entry point.
 *
 * `check` prints diagnostics and says nothing else; `build` writes the
 * compiled artifacts as JSON. Neither reads the environment, neither touches
 * a network, and neither writes outside the path the caller names.
 *
 * Everything here is a pure function of `argv` plus the injected `Io`, so the
 * spec drives the real code paths with an in-memory filesystem instead of
 * asserting on a subprocess's scrollback.
 */

import { compile, type CompileResult } from "./compile.ts";
import { HSX_IR_VERSION, HSX_VERSION } from "./version.ts";

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

const USAGE_TEXT = `hsx ${HSX_VERSION}, the HSX compiler

Usage:
  hsx check <file.hsx> [--strict]
  hsx build <file.hsx> [--out <file.json>] [--strict]
  hsx --version
  hsx --help

Commands:
  check   Compile and report diagnostics. Prints nothing when the program is clean.
  build   Compile and write the HSX-JSON IR document and Business Frame as JSON.

Options:
  --out <file>  Write build output to this path instead of stdout.
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
    io.out(`${HSX_VERSION} (IR version ${HSX_IR_VERSION})`);
    return OK;
  }
  if (command !== "check" && command !== "build") {
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

  const result = compile(source);
  for (const line of diagnosticLines(parsed.file, result)) io.err(line);

  const refused =
    result.verdict === "invalid" ||
    (parsed.strict && result.verdict === "warning");

  if (command === "check") {
    return refused ? REFUSED : OK;
  }

  if (!result.artifacts) return REFUSED;
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
  readonly out?: string;
  readonly strict: boolean;
}

function parseOptions(
  args: readonly string[],
  command: "build" | "check",
): Options | { readonly error: string } {
  let file: string | undefined;
  let out: string | undefined;
  let strict = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--strict") {
      strict = true;
      continue;
    }
    if (argument === "--out") {
      if (command !== "build") return { error: "--out belongs to hsx build" };
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
  return { file, ...(out === undefined ? {} : { out }), strict };
}

/** `file:line:col: severity [stage] message`, the shape editors already parse. */
function diagnosticLines(
  file: string,
  result: CompileResult,
): readonly string[] {
  return result.diagnostics.map(
    (diagnostic) =>
      `${file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.severity} [${diagnostic.stage}] ${diagnostic.message}`,
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
