import { expect, test } from "bun:test";
import { runCli } from "../src/cli.ts";

// Mutation: restore the ignored flags or accept --out on check.
test("CLI refuses options that cannot affect the requested command", async () => {
  for (const argv of [
    ["check", "p.hsx", "--strict"],
    ["build", "p.hsx", "--json"],
    ["check", "p.hsx", "--out", "p.udl"],
    ["build", "p.hsx", "--out", "--strict"],
    ["build", "p.hsx", "--out"],
    ["build", "p.hsx", "--out", "a", "--out", "b"],
  ]) {
    const reads: string[] = [];
    const errors: string[] = [];
    const code = await runCli(argv, {
      out: () => {},
      err: (line) => errors.push(line),
      readFile: async (path) => {
        reads.push(path);
        return 'program p "P"';
      },
      writeFile: async () => {},
    });
    expect(code).toBe(2);
    expect(errors).toHaveLength(1);
    expect(reads).toEqual([]);
  }
});

// Mutation: consume --out without writing the formatted result.
test("CLI writes a requested output file", async () => {
  const writes: [string, string][] = [];
  const output: string[] = [];
  const code = await runCli(["format", "p.hsx", "--out", "formatted.hsx"], {
    out: (line) => output.push(line),
    err: (line) => output.push(line),
    readFile: async () => 'program p "P"  ',
    writeFile: async (path, text) => {
      writes.push([path, text]);
    },
  });
  expect(code).toBe(0);
  expect(writes).toEqual([["formatted.hsx", 'program p "P"\n']]);
  expect(output).toEqual([]);
});
