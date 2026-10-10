import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";
import { templateGuide } from "../src/template-guide.ts";

const program = (attach: string) => `program everytest "Every test"
currency SAR
use money
use booking
object plan "Plan" {
  fields { bike: text }
  columns: [bike]
${attach}
}`;

const schedule = (extra = "") => `  attach dues = money.schedule {
    payer: owner, payee: operator, amount: 360 SAR, count: 3${extra}
    expose create as start_plan
  }`;

// Mutation: parse `1 month` as two tokens, or drop the template name, and the
// diagnostic moves to the next line as "expected :".
test("an unknown tunable is named on its own line with the template's tunables", () => {
  const source = program(schedule(", every: 1 month"));
  const result = compile(source);
  expect(result.verdict).toBe("invalid");
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.message).toBe(
    'money.schedule has no tunable "every". Tunables: payer, payee, amount, count',
  );
  expect(source.split("\n")[diagnostic!.line - 1]).toContain("every: 1 month");
  expect(diagnostic!.fix).not.toContain("write :");
});

test("a close miss suggests the tunable", () => {
  const result = compile(program(schedule(", cont: 3")));
  expect(result.diagnostics[0]!.message).toContain("Did you mean `count`?");
});

test("a calendar duration on a duration tunable asks for a fixed one", () => {
  const result = compile(
    program(
      "  attach trip = booking.reservation { customer: actor, operator: owner, early_until: 1 month }",
    ),
  );
  expect(result.diagnostics[0]!.message).toContain(
    "1 month is not a fixed duration",
  );
  expect(result.diagnostics[0]!.fix).toContain("30d");
});

const transfer = `  attach once = money.transfer {
    payer: owner, payee: operator, amount: 10 SAR
    expose create as buy
    expose pay as pay_now
  }`;

// Mutation: skip record children, guess a purpose for the std, or turn the
// warning into an error, and these rows change.
test("a money move with no purpose warns with the economics line to add", () => {
  const source = program(`${schedule()}\n${transfer}`);
  const result = compile(source);
  expect(result.verdict).toBe("valid");
  expect(result.diagnostics).toEqual([]);
  expect(
    result.warnings.map(({ code, message, fix, severity, line }) => ({
      code,
      message,
      fix,
      severity,
      line: source.split("\n")[line - 1]!.trim(),
    })),
  ).toEqual([
    {
      code: "economic_purpose_missing",
      message:
        "dues: occurrence.pay moves money with no declared purpose, so the books will not count it as revenue or a payout",
      fix: "add economics occurrence.pay { purpose: earning, sourceParty: payer } inside attach dues",
      severity: "warning",
      line: "attach dues = money.schedule {",
    },
    {
      code: "economic_purpose_missing",
      message:
        "once: pay moves money with no declared purpose, so the books will not count it as revenue or a payout",
      fix: "add economics pay { purpose: earning, sourceParty: payer } inside attach once",
      severity: "warning",
      line: "attach once = money.transfer {",
    },
  ]);
});

test("pasting each fix classifies the move and clears the warning", () => {
  const warned = compile(program(`${schedule()}\n${transfer}`));
  const lines = warned.warnings.map(
    (warning) => /economics [^}]+\}/.exec(warning.fix)![0],
  );
  const fixed = compile(
    program(
      `${schedule(`\n    ${lines[0]}`)}\n${transfer.replace(
        "expose pay as pay_now",
        `expose pay as pay_now\n    ${lines[1]}`,
      )}`,
    ),
  );
  expect(fixed.diagnostics).toEqual([]);
  expect(fixed.warnings).toEqual([]);
  const occurrence = fixed.artifacts!.document.instruments.find(
    (instrument) => instrument.id === "plan_dues_occurrence",
  )!;
  expect(occurrence.actions.pay!.moves[0]!.economics).toEqual({
    purpose: "earning",
    sourceParty: "owner",
  });
});

test("a payee who is a participant passes money through", () => {
  const result = compile(
    program(schedule().replace("payee: operator", "payee: actor")),
  );
  expect(result.warnings[0]!.fix).toContain(
    "economics occurrence.pay { purpose: pass_through, sourceParty: payer }",
  );
});

test("a template that declares its purposes gives no warning", () => {
  const result = compile(
    program(
      "  attach deposit = money.hold { payer: actor, payee: owner, amount: 750 SAR }",
    ),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("an unknown record selector lists the records", () => {
  const result = compile(
    program(
      schedule(
        "\n    economics occurrences.pay { purpose: earning, sourceParty: payer }",
      ),
    ),
  );
  expect(result.diagnostics[0]!.message).toContain(
    "unknown economics action occurrences",
  );
  expect(result.diagnostics[0]!.fix).toContain("record (occurrence)");
});

test("the catalog guide shows the economics line for an unclassified template", () => {
  const notes = templateGuide("money.schedule")!.notes.join("\n");
  expect(notes).toContain("`economics occurrence.pay { purpose: ");
  expect(notes).toContain("earning when operator receives the money");
  expect(templateGuide("money.hold")!.notes.join("\n")).not.toContain(
    "economics declares",
  );
});

const financing = readFileSync(
  new URL("../examples/financing.hsx", import.meta.url),
  "utf8",
);

// Mutation: drop the `:` guard on `1 month` and the number at a line's end
// swallows the next line's unit-named key, so these programs stop compiling.
test.each([
  [
    "an installments tunable",
    financing
      .replace(
        "months: 3, pricing: flat_total, profit_rate: 0%, share: 0%",
        "share: 0%",
      )
      .replace(
        "max_extension: 30d, max_amendments: 1, amendment_expiry: 7d",
        "max_extension: 30d, amendment_expiry: 7d, max_amendments: 2\n    months: 2, pricing: flat_total, profit_rate: 0%",
      ),
  ],
  [
    "a field default",
    `program cars "Cars"
use money
object car "Car" {
  fields {
    seats: integer = 4
    year: integer
  }
  columns: [seats, year]
}`,
  ],
])(
  "a number at a line's end leaves the key on the next line alone: %s",
  (_, source) => {
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
  },
);
