import { examples } from "@hyperscale0/hsx/examples";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describe, highlight } from "@hyperscale0/hsx/language";
import { KEYWORD_HELP } from "../src/keywords.ts";
import { KEYWORDS, lex, scan } from "../src/lex.ts";
import { HEADER_NAMES } from "../src/headers.ts";
import { parseProgram } from "../src/parse.ts";
import { bundledStandardLibrary } from "../src/std-library.ts";

const source = `program shop "Shop"
use escrow
party buyer: person
object order "Order" {
 fields { price: money }
 attach payment = escrow.hold {
  payer: buyer, payee: owner, accept_within: 24h
  expose accept as receive
 }
}`;
const kindAt = (text: string, offset: number) =>
  highlight(text).find((s) => s.start <= offset && offset < s.end)?.class;

test("keywords have business help and executable TextMate patterns", () => {
  const grammar = JSON.parse(
    readFileSync(
      new URL(
        "../editors/vscode/syntaxes/hsx.tmLanguage.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { patterns: { name: string; match?: string }[] };
  const patterns = grammar.patterns
    .filter((p) => p.name.startsWith("keyword."))
    .map((p) => new RegExp(p.match!));
  for (const keyword of KEYWORDS) {
    expect(KEYWORD_HELP[keyword][0].length).toBeGreaterThan(10);
    expect(describe(keyword, 0)?.summary).toBe(KEYWORD_HELP[keyword][0]);
    expect(patterns.some((p) => p.test(keyword))).toBe(true);
    expect(patterns.some((p) => p.test(`prefix_${keyword}_suffix`))).toBe(
      false,
    );
  }
});

test("every standard instrument authors its summary instead of relying on a name fallback", () => {
  for (const name of HEADER_NAMES) {
    const parsed = parseProgram(bundledStandardLibrary.source(name)!);
    expect(parsed.diagnostics).toEqual([]);
    for (const decl of parsed.program.decls)
      if (decl.kind === "instrument") {
        const summary = decl.body.entries.find(
          (e) => e.key === "summary",
        )?.value;
        expect(summary?.kind).toBe("text");
        if (summary?.kind === "text")
          expect(summary.value.trim().length).toBeGreaterThan(0);
      }
  }
});

test("attachments resolve headers, instruments, parameters, parties and actions", () => {
  const cases = [
    ["use escrow", 4, "header"],
    ["escrow.hold", 7, "instrument"],
    ["payer:", 0, "parameter"],
    ["payer: buyer", 7, "party"],
    ["owner", 0, "role"],
    ["expose accept", 7, "action"],
    ["price:", 0, "field"],
    ["price: money", 7, "type"],
  ] as const;
  for (const [needle, delta, kind] of cases)
    expect(kindAt(source, source.indexOf(needle) + delta)).toBe(kind);
  const hover = describe(source, source.indexOf("hold"))!;
  expect(hover.summary).toBe(
    "Hold the subject price through delivery, acceptance and verified return.",
  );
  expect(hover.signature).toContain("accept_within: duration = 48h");
  expect(hover.details).toContainEqual({
    label: "accept_within",
    value: "duration = 48h; bounds 1 to 9007199254740991 in UDL units",
  });
  expect(hover.details?.find((d) => d.label === "States")?.value).toContain(
    "released",
  );
  expect(
    describe(source, source.indexOf("expose accept") + 7)?.details,
  ).toEqual([{ label: "Actor", value: "{ party: payer }" }]);
  // The same binding survives the editor's missing closing braces.
  const unfinished = source.slice(0, source.indexOf("24h") + 3);
  expect(kindAt(unfinished, unfinished.indexOf("payer:"))).toBe("parameter");
  expect(kindAt(unfinished, unfinished.indexOf("payer: buyer") + 7)).toBe(
    "party",
  );
});

test("local declarations keep parameter and state meanings inside their instrument", () => {
  const local = `header local
instrument first(amount: money = 10 SAR) {
 summary: "First agreement."
 fields { saved: money }
 lifecycle { states: [open, closed], initial: open }
 action pay { from: open, to: closed moves amount from self.saved to owner }
}
instrument second(amount: integer = 2) {
 summary: "Second agreement."
 fields { saved: integer }
 lifecycle { states: [open], initial: open }
 action pay { input { saved: text } from: open, to: open requires self.saved == amount requires input.saved == "ok" }
}`;
  expect(describe(local, local.indexOf("moves amount") + 6)?.signature).toBe(
    "amount: money = 10 SAR",
  );
  expect(describe(local, local.lastIndexOf("amount"))?.signature).toBe(
    "amount: integer = 2",
  );
  expect(kindAt(local, local.indexOf("from: open") + 6)).toBe("state");
  expect(describe(local, local.lastIndexOf("self.saved") + 5)?.signature).toBe(
    "saved: integer",
  );
  expect(describe(local, local.lastIndexOf("input.saved") + 6)?.signature).toBe(
    "saved: text",
  );
  expect(describe(local, local.indexOf("first"))?.summary).toBe(
    "First agreement.",
  );
});

test("editor scanning retains comments and partial strings without changing compiler tokens", () => {
  const text =
    '"😀 // text" // comment\n10 SAR 2% 48h 2026-01-01 7 == "unfinished // text';
  expect(
    highlight(text).map((s) => [text.slice(s.start, s.end), s.class]),
  ).toEqual([
    ['"😀 // text"', "string"],
    ["// comment", "comment"],
    ["10", "money"],
    ["SAR", "money"],
    ["2%", "percent"],
    ["48h", "duration"],
    ["2026-01-01", "date"],
    ["7", "number"],
    ["==", "operator"],
    ['"unfinished // text', "string"],
  ]);
  const complete = 'use escrow // comment\n"😀"';
  expect(scan(complete).tokens.filter((t) => t.kind !== "comment")).toEqual(
    lex(complete).tokens,
  );
  expect(lex('"unfinished').diagnostics.length).toBeGreaterThan(0);
});

test("all prefixes and arbitrary UTF-16 input produce ordered spans and total hovers", () => {
  const assertTotal = (text: string) => {
    let end = 0;
    for (const span of highlight(text)) {
      expect(span.start).toBeGreaterThanOrEqual(end);
      expect(span.end).toBeGreaterThan(span.start);
      expect(span.end).toBeLessThanOrEqual(text.length);
      const hover = describe(text, span.start);
      if (hover)
        expect(hover.span).toEqual({ start: span.start, end: span.end });
      end = span.end;
    }
    for (const offset of [-1, text.length, NaN, Infinity, 0.5])
      expect(describe(text, offset)).toBeNull();
  };
  for (let end = 0; end <= source.length; end++)
    assertTotal(source.slice(0, end));
  let seed = 41;
  for (let sample = 0; sample < 100; sample++) {
    let text = "";
    for (let i = 0; i < 80; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += String.fromCharCode(seed & 65535);
    }
    assertTotal(text);
  }
  assertTotal("(".repeat(1000));
  expect(describe("use escrow", 3)).toBeNull();
});

test("custom library edits replace hover metadata and library failures stay total", () => {
  let summary = "Old terms.";
  const library = {
    source: () =>
      `header custom\ninstrument hold() { summary: "${summary}" fields {} }`,
  };
  const text = 'program p "P"\nuse custom\nx = custom.hold {}';
  const offset = text.indexOf("hold");
  expect(describe(text, offset, library)?.summary).toBe("Old terms.");
  summary = "New terms.";
  expect(describe(text, offset, library)?.summary).toBe("New terms.");
  expect(
    describe(text, offset, {
      source: () => {
        throw new Error("unavailable");
      },
    }),
  ).toBeNull();
  expect(
    describe(text, offset, { source: () => "header custom instrument" }),
  ).toBeNull();
});

test("browser consumers can bundle the language entry without Node polyfills", async () => {
  const result = await Bun.build({
    entrypoints: [
      new URL("../src/language.ts", import.meta.url).pathname,
      new URL("../src/examples.ts", import.meta.url).pathname,
    ],
    target: "browser",
  });
  expect(result.success).toBe(true);
});

test("every example token is coloured and every UTF-16 offset permits a hover", () => {
  for (const example of examples) {
    const highlights = highlight(example.source);
    const tokens = scan(example.source).tokens.filter(
      (token) => token.kind !== "eof",
    );
    expect(highlights.map(({ start, end }) => ({ start, end }))).toEqual(
      tokens.map((token) => token.span),
    );
    for (const span of highlights) expect(span.class.length).toBeGreaterThan(0);
    for (let offset = 0; offset <= example.source.length; offset++) {
      const hover = describe(example.source, offset);
      if (hover) {
        expect(hover.span.start).toBeLessThanOrEqual(offset);
        expect(hover.span.end).toBeGreaterThan(offset);
      }
    }
  }
});
