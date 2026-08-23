import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, type Io } from "../src/cli.ts";
import { HSX_VERSION } from "../src/version.ts";

const examples = join(import.meta.dir, "..", "examples");
const CLEAN = join(examples, "01-first-program", "tip-jar.hsx");
const BROKEN = join(examples, "03-diagnostics", "corner-shop.hsx");

interface Run {
  readonly code: number;
  readonly err: string;
  readonly out: string;
  readonly written: Map<string, string>;
}

const run = async (
  argv: readonly string[],
  files: Record<string, string> = {},
): Promise<Run> => {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  const io: Io = {
    err: (line) => void err.push(line),
    out: (line) => void out.push(line),
    readFile: async (path) => {
      const injected = files[path];
      if (injected !== undefined) return injected;
      return readFileSync(path, "utf8");
    },
    writeFile: async (path, contents) => void written.set(path, contents),
  };
  const code = await runCli(argv, io);
  return { code, err: err.join("\n"), out: out.join("\n"), written };
};

describe("hsx check", () => {
  it("says nothing and exits 0 on a clean program", async () => {
    const result = await run(["check", CLEAN]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe("");
  });

  it("prints one file:line:col line per diagnostic and exits 1", async () => {
    const result = await run(["check", BROKEN]);
    expect(result.code).toBe(1);
    expect(result.err.split("\n")).toEqual([
      `${BROKEN}:15:12: error [check] settlement basket payee must name a declared party; there is no party named grocer`,
      `${BROKEN}:17:17: error [check] settlement basket decides release through port confirm_pickup, but no port with that name is declared`,
      `${BROKEN}:18:21: error [check] the on_cancel split must account for exactly 100%; these shares total 60%`,
    ]);
  });

  it("exits 0 on a warning, and 1 on the same warning under --strict", async () => {
    const lintful = `program lintful "Lintful"
import { instant_transfer } from "settlement"
party payer_side: person
party payee_side: business
party bystander: person
settlement pay = instant_transfer {
  payer: payer_side
  payee: payee_side
  amount: total: money(SAR)
}
`;
    const files = { "lint.hsx": lintful };
    const relaxed = await run(["check", "lint.hsx"], files);
    expect(relaxed.code).toBe(0);
    expect(relaxed.err).toContain("warning [check]");
    expect(relaxed.err).toContain("bystander");

    const strict = await run(["check", "lint.hsx", "--strict"], files);
    expect(strict.code).toBe(1);
  });
});

describe("hsx build", () => {
  it("writes the document and frame to --out", async () => {
    const result = await run(["build", CLEAN, "--out", "ir.json"]);
    expect(result.code).toBe(0);
    const written = result.written.get("ir.json");
    expect(written).toBeDefined();
    const artifacts = JSON.parse(written as string) as {
      document: { hsx: number; nouns: { id: string }[]; product: string };
      frame: { moneyEvents: { key: string }[] };
    };
    expect(artifacts.document.hsx).toBe(1);
    expect(artifacts.document.product).toBe("tip_jar");
    expect(artifacts.document.nouns.map((noun) => noun.id)).toEqual(["tip"]);
    expect(artifacts.frame.moneyEvents.map((event) => event.key)).toEqual([
      "tip_pay_1",
    ]);
    expect(written).toEndWith("\n");
  });

  it("prints to stdout when --out is absent", async () => {
    const result = await run(["build", CLEAN]);
    expect(result.code).toBe(0);
    expect(result.written.size).toBe(0);
    expect(JSON.parse(result.out).document.product).toBe("tip_jar");
  });

  it("writes nothing and exits 1 when the program is refused", async () => {
    const result = await run(["build", BROKEN, "--out", "ir.json"]);
    expect(result.code).toBe(1);
    expect(result.written.size).toBe(0);
    expect(result.err).toContain("error [check]");
  });
});

describe("hsx usage", () => {
  it("prints usage and exits 2 with no arguments", async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.out).toContain("Usage:");
  });

  it("prints usage and exits 0 for --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("hsx check <file.hsx>");
  });

  it("prints the package version and the IR version for --version", async () => {
    const result = await run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${HSX_VERSION} (IR version 1)`);
  });

  it("exits 2 on an unknown command", async () => {
    const result = await run(["lower", CLEAN]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown command "lower"');
  });

  it("exits 2 on an unknown option, a missing file, and a second file", async () => {
    expect((await run(["check", CLEAN, "--loud"])).code).toBe(2);
    expect((await run(["check"])).code).toBe(2);
    expect((await run(["check", CLEAN, CLEAN])).code).toBe(2);
    expect((await run(["build", CLEAN, "--out"])).code).toBe(2);
    expect((await run(["check", CLEAN, "--out", "x.json"])).code).toBe(2);
  });

  it("exits 2 and names the path when the file cannot be read", async () => {
    const result = await run(["check", join(examples, "nope.hsx")]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("cannot read");
  });
});
