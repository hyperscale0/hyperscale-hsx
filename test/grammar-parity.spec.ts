// The TextMate grammar hand-copies two word lists the compiler owns. Nothing
// else catches the drift: an archetype added to the stdlib or a keyword added
// to the lexer stays unhighlighted, and an archetype removed keeps its color.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTLEMENT_ARCHETYPES } from "../src/check.ts";
import { KEYWORDS } from "../src/lex.ts";

const grammar = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "editors",
      "vscode",
      "syntaxes",
      "hsx.tmLanguage.json",
    ),
    "utf8",
  ),
) as { readonly repository: Record<string, { readonly match?: string }> };

/**
 * The bare words one repository rule highlights, read out of the first capture
 * group of its match. A rule that stops being a plain alternation raises rather
 * than reporting an empty set: a check that quietly stops reading its own
 * source is worth less than no check.
 */
function alternates(rule: string): readonly string[] {
  const match = grammar.repository[rule]?.match;
  if (match === undefined) throw new Error(`grammar has no rule ${rule}`);
  const group = /\(([a-z_|]+)\)/.exec(match);
  if (!group) throw new Error(`rule ${rule} no longer lists bare words`);
  return group[1]!.split("|");
}

describe("editors/vscode grammar parity", () => {
  it("highlights exactly the archetypes the checker admits", () => {
    expect([...alternates("archetype")].sort()).toEqual(
      [...SETTLEMENT_ARCHETYPES].sort(),
    );
  });

  it("highlights exactly the keywords the lexer reserves", () => {
    // `port` introduces a declaration and appears in value position, so it is
    // spelled in two rules; the union is what must match.
    const highlighted = new Set([
      ...alternates("declaration"),
      ...alternates("import"),
      ...alternates("port-reference"),
    ]);
    expect([...highlighted].sort()).toEqual([...KEYWORDS].sort());
  });
});
