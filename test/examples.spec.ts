import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/index.ts";

const example = (...segments: string[]): string =>
  readFileSync(join(import.meta.dir, "..", "examples", ...segments), "utf8");

/**
 * The examples are the teaching material, so a change that quietly breaks one
 * is a change that ships a lie. Each one is pinned to what it is supposed to
 * demonstrate, not merely to "compiles".
 */
describe("examples", () => {
  it("01 · the first program moves money once, straight through", () => {
    const result = compile(example("01-first-program", "tip-jar.hsx"));
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    const nouns = result.artifacts!.document.nouns as { escrow?: boolean }[];
    expect(nouns).toHaveLength(1);
    expect(nouns[0]!.escrow).toBeUndefined();
    const events = result.artifacts!.frame.moneyEvents as { key: string }[];
    expect(events.map((event) => event.key)).toEqual(["tip_pay_1"]);
  });

  it("02 · the archetype example holds money and pays out through the port", () => {
    const result = compile(
      example("02-imports-and-archetypes", "photo-booth.hsx"),
    );
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    const nouns = result.artifacts!.document.nouns as {
      escrow?: boolean;
      verbs: Record<string, { moneyEvent?: string }>;
    }[];
    expect(nouns[0]!.escrow).toBe(true);
    // The port is a verb of its own; who may answer it rides on the frame rule.
    expect(nouns[0]!.verbs.confirm_delivery?.moneyEvent).toBe(
      "booking_release_company",
    );
    const rules = result.artifacts!.frame.rules as {
      allowedActors: string[];
      enforcement: string;
    }[];
    expect(rules.map((rule) => rule.allowedActors)).toEqual([["company"]]);
    expect(rules[0]!.enforcement).toBe("tenant_app");
    const events = result.artifacts!.frame.moneyEvents as { key: string }[];
    expect(events.map((event) => event.key)).toEqual([
      "booking_fund",
      "booking_service_fee",
      "booking_release_company",
      "booking_release_platform",
      "booking_cancel_renter",
      "booking_cancel_company",
      "booking_abandon",
    ]);
  });

  it("03 · the diagnostics example is refused with exactly the three lessons", () => {
    const result = compile(example("03-diagnostics", "corner-shop.hsx"));
    expect(result.verdict).toBe("invalid");
    expect(result.artifacts).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        column: 12,
        line: 15,
        message:
          "settlement basket payee must name a declared party; there is no party named grocer",
        severity: "error",
        stage: "check",
      },
      {
        column: 17,
        line: 17,
        message:
          "settlement basket decides release through port confirm_pickup, but no port with that name is declared",
        severity: "error",
        stage: "check",
      },
      {
        column: 21,
        line: 18,
        message:
          "the on_cancel split must account for exactly 100%; these shares total 60%",
        severity: "error",
        stage: "check",
      },
    ]);
  });

  it("03 · the repaired program compiles clean", () => {
    const result = compile(example("03-diagnostics", "corner-shop-fixed.hsx"));
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
  });

  it("04 · the complete product lowers all three settlements", () => {
    const result = compile(example("04-complete-product", "study-hall.hsx"));
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    const nouns = result.artifacts!.document.nouns as { id: string }[];
    expect(nouns.map((noun) => noun.id)).toEqual([
      "lesson",
      "kit_deposit",
      "tutor_payout",
    ]);
    const frame = result.artifacts!.frame as {
      mechanics: string[];
      moneyEvents: { key: string }[];
    };
    expect([...frame.mechanics].sort()).toEqual(["escrow", "marketplace"]);
    expect(frame.moneyEvents.map((event) => event.key)).toEqual([
      "lesson_fund",
      "lesson_release_tutor",
      "lesson_release_platform",
      "lesson_abandon",
      "kit_deposit_hold_1",
      "tutor_payout_pool_1",
      "tutor_payout_pool_2",
      "tutor_payout_payout_1",
      "tutor_payout_payout_2",
    ]);
  });
});

/**
 * The README quotes the photo-booth example and then counts what it compiles
 * to. Both halves rot silently: the quote drifts when the example changes, and
 * the counts drift when lowering changes. Pin both against the real file.
 */
describe("README", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

  const quoted = /```hsx\n([\s\S]*?)```/.exec(readme)?.[1];

  /**
   * Compared line by line with comments and blank lines dropped: the README
   * lays the stanzas out its own way, but every line of code has to be the
   * example's.
   */
  const codeLines = (source: string): string[] =>
    source
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== "" && !line.trimStart().startsWith("//"));

  it("quotes the photo-booth example verbatim, comments aside", () => {
    expect(codeLines(quoted!)).toEqual(
      codeLines(example("02-imports-and-archetypes", "photo-booth.hsx")),
    );
  });

  it("counts the quoted program correctly", () => {
    const lines = quoted!.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(20);
    expect(readme).toContain("Those 20 lines compile to one");

    const result = compile(quoted!);
    expect(result.verdict).toBe("valid");
    const noun = (
      result.artifacts!.document.nouns as {
        fields: Record<string, unknown>;
        verbs: Record<string, unknown>;
      }[]
    )[0]!;
    expect(Object.keys(noun.fields)).toEqual([
      "bookingFee",
      "piece1Amount",
      "piece2Amount",
      "piece3Amount",
      "serviceFeeAmount",
    ]);
    expect(readme).toContain("**five money fields**");
    expect(Object.keys(noun.verbs)).toHaveLength(15);
    expect(readme).toContain("**fifteen verbs**");
  });
});
