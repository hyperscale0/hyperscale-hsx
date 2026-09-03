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
    // Binding one bad party no longer suppresses the independent bad port.
    expect(result.err.split("\n")).toEqual([
      `${BROKEN}:17:17: error [typecheck] decision port confirm_pickup is not declared`,
      `${BROKEN}:15:12: error [bind] party role refers to grocer, which is not declared`,
    ]);
  });
});

describe("hsx build", () => {
  it("writes the document and frame to --out", async () => {
    const result = await run(["build", CLEAN, "--out", "ir.json"]);
    expect(result.code).toBe(0);
    const written = result.written.get("ir.json");
    expect(written).toBeDefined();
    const artifacts = JSON.parse(written as string) as {
      document: { udl: number; instruments: { id: string }[]; product: string };
      frame: { moneyEvents: { key: string }[] };
    };
    expect(artifacts.document.udl).toBe(1);
    expect(artifacts.document.product).toBe("tip_jar");
    expect(
      artifacts.document.instruments.map((instrument) => instrument.id),
    ).toEqual(["tip"]);
    expect(artifacts.frame.moneyEvents.map((event) => event.key)).toEqual([
      "transfer",
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
    expect(result.err).toContain("error [bind]");
  });
});

describe("hsx cost", () => {
  it("reads the packaged card and prints its effect rows as a table", async () => {
    const result = await run(["cost", CLEAN]);
    expect(result.code).toBe(0);
    expect(result.out.split("\n")[0]).toMatch(
      /^costTableVersion\t\d{4}-\d{2}-\d{2}\.\d+$/,
    );
    expect(result.out.split("\n")[1]).toBe(
      "instrument.action\teffect\tunit\tcount\ttotal\tpayer",
    );
    expect(result.out).toContain("tip.pay_piece_1\tmoves.transfer.internal");
    expect(result.out).toContain("75 SAR minor + amount-dependent (11 bps)");
    expect(result.out).toContain("\tend_customer");
  });

  it("prints the version-pinned manifest as JSON", async () => {
    const result = await run(["cost", CLEAN, "--json"]);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.out) as {
      actions: readonly {
        components: readonly { signature: string }[];
      }[];
      costTableVersion: string;
    };
    expect(manifest.costTableVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(
      manifest.actions.flatMap((action) => action.components),
    ).toContainEqual(
      expect.objectContaining({ signature: "moves.transfer.internal" }),
    );
  });

  it("writes cost JSON to --out", async () => {
    const result = await run(["cost", CLEAN, "--out", "cost.json"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    const written = result.written.get("cost.json");
    expect(written).toBeDefined();
    expect(JSON.parse(written as string).costTableVersion).toMatch(
      /^\d{4}-\d{2}-\d{2}\.\d+$/,
    );
    expect(written).toEndWith("\n");
  });

  it("exits 1 and prints no table for a refused program", async () => {
    const result = await run(["cost", BROKEN]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
  });
});

describe("hsx explain", () => {
  it("prints the catalog title, fix, and example", async () => {
    const result = await run(["explain", "HSX1201"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "HSX1201 Linear money consumed more than once",
    );
    expect(result.out).toContain("Fix:");
    expect(result.out).toContain("Example:");
  });

  it("exits 2 for an unknown diagnostic code", async () => {
    const result = await run(["explain", "HSX9999"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown diagnostic code HSX9999");
  });
});

describe("hsx format", () => {
  it("prints canonical source without changing the input file", async () => {
    const result = await run(["format", "general.hsx"], {
      "general.hsx": "module std.payments\nexport const fee:bps=25",
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe(
      "module std.payments;\nexport const fee: bps = 25;",
    );
    expect(result.written.size).toBe(0);
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

  it("prints the package and UDL versions for --version", async () => {
    const result = await run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${HSX_VERSION} (UDL version 1)`);
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
    expect((await run(["build", CLEAN, "--json"])).code).toBe(2);
  });

  it("exits 2 and names the path when the file cannot be read", async () => {
    const result = await run(["check", join(examples, "nope.hsx")]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("cannot read");
  });
});
