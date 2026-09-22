import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { headerManifest } from "./headers.ts";
import { HSX_VERSION } from "./version.ts";
import { compile } from "./compile.ts";
import { format } from "./format.ts";
import { serializeUdl } from "@hyperscale0/udl";
const usage =
  "hsx build|format|cost <file> [--out path]\nhsx check <file>\nhsx headers --json";
const standardLibrary = {
  source: (header: string) => {
    for (const base of ["../std/", "../../std/"]) {
      const file = new URL(`${base}${header}.hsx`, import.meta.url);
      if (existsSync(file)) return readFileSync(file, "utf8");
    }
    return undefined;
  },
};

export interface Io {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
}
export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  const [command, file, ...options] = argv;
  if (command === "headers") {
    if (file !== "--json" || options.length) {
      io.err("usage: hsx headers --json");
      return 2;
    }
    io.out(JSON.stringify(headerManifest(standardLibrary), null, 2));
    return 0;
  }
  if (["--help", "help", "-h"].includes(command ?? "")) {
    io.out(usage);
    return 0;
  }
  if (command === "--version") {
    io.out(`${HSX_VERSION} (UDL 4)`);
    return 0;
  }
  if (
    !command ||
    !file ||
    !["build", "check", "format", "cost"].includes(command)
  ) {
    io.err(`usage:\n${usage}`);
    return 2;
  }
  let output: string | undefined;
  for (let i = 0; i < options.length; i++) {
    if (
      command !== "check" &&
      options[i] === "--out" &&
      options[i + 1] &&
      !options[i + 1]!.startsWith("--") &&
      output === undefined
    )
      output = options[++i];
    else {
      io.err(`unknown option ${options[i]}`);
      return 2;
    }
  }
  try {
    const source = await io.readFile(file);
    let text: string;
    if (command === "format") {
      const result = format(source);
      if (!result.ok) {
        result.diagnostics.forEach((d) => io.err(`${file}: ${d.message}`));
        return 1;
      }
      text = result.formatted;
    } else {
      const result = compile(source, { standardLibrary });
      for (const d of result.diagnostics)
        io.err(
          `${d.source && d.source !== "program" ? d.source : file}:${d.line}:${d.column}: ${d.code} ${d.message}. ${d.fix}`,
        );
      if (!result.artifacts || result.verdict !== "valid") return 1;
      if (command === "check") return 0;
      text =
        command === "cost"
          ? JSON.stringify(result.artifacts.costManifest, null, 2) + "\n"
          : serializeUdl(result.artifacts.document);
    }
    if (output) await io.writeFile(output, text);
    else io.out(text.trimEnd());
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (import.meta.main)
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, text) => writeFile(path, text, "utf8"),
  });
