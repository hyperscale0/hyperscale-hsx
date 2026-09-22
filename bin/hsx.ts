#!/usr/bin/env node
/**
 * The `hsx` executable. Everything it does lives in `runCli`; this file only
 * binds that function to the real filesystem and the real streams.
 */

import { readFile, writeFile } from "node:fs/promises";
import { runCli } from "../src/cli.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  err: (line) => process.stderr.write(`${line}\n`),
  out: (line) => process.stdout.write(`${line}\n`),
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, contents) => writeFile(path, contents, "utf8"),
});
