import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

// The Desk & Key key deposit Architect saved on r338. It compiled, and every
// return_key then refused at run time with economic_source_unbound.
const deposit = (
  refund: string,
  forfeit = "",
) => `program desk_and_key "Desk & Key"
use money

instrument key_deposit(member: party) {
  fields {
    held: account of self
    deposit: money = 300 SAR
  }
  lifecycle { states: [pending, held, returned, forfeited], initial: pending }
  action create { actor: { party: member } }
  action pay_deposit {
    from: pending, to: held, actor: { party: member }
    moves self.deposit from member to self.held
  }
  action refund_deposit {
    from: held, to: returned, actor: { party: programOperator }
    moves self.held.balance from self.held to member
  }
  action forfeit_deposit {
    from: held, to: forfeited, actor: { party: programOperator }
    moves self.held.balance from self.held to programOperator
  }
}

object member "Member" {
  fields { name: text }
  columns: [name]
  attach deposit = key_deposit {
    member: owner
    economics pay_deposit { purpose: pass_through, sourceParty: member }
    ${refund}
    ${forfeit}
    expose create as request_key
    expose pay_deposit as pay_key_deposit
    expose refund_deposit as return_key
    expose forfeit_deposit as report_lost_key
  }
}`;

const kept =
  "economics forfeit_deposit { purpose: earning, sourceParty: member }";

// Mutation: drop the check, or compare parties before roles resolve, and the
// r338 program compiles again.
test("a refund out of the company's held account naming the customer fails check", () => {
  const result = compile(
    deposit(
      "economics refund_deposit { purpose: pass_through, sourceParty: member }",
      kept,
    ),
  );
  expect(result.verdict).toBe("invalid");
  expect(
    result.diagnostics.map(({ code, message, fix }) => ({
      code,
      message,
      fix,
    })),
  ).toEqual([
    {
      code: "economic_source_unbound",
      message:
        "deposit: refund_deposit moves money out of self.held, which is your company's account, but names member as the source. Every run of this action would refuse with economic_source_unbound.",
      fix: "Set sourceParty: programOperator on economics refund_deposit, or move the money from an account member owns.",
    },
  ]);
});

// Mutation: drop the held-earning exception and a kept deposit, which the
// ledger books, fails check.
test("the company's source and a held earning both pass", () => {
  const result = compile(
    deposit(
      "economics refund_deposit { purpose: pass_through, sourceParty: programOperator }",
      kept,
    ),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("a customer's account naming the company as the source fails check", () => {
  const result = compile(
    deposit(
      "economics refund_deposit { purpose: pass_through, sourceParty: programOperator }",
      kept,
    ).replace(
      "economics pay_deposit { purpose: pass_through, sourceParty: member }",
      "economics pay_deposit { purpose: pass_through, sourceParty: programOperator }",
    ),
  );
  expect(
    result.diagnostics.map(({ code, message }) => ({ code, message })),
  ).toEqual([
    {
      code: "economic_source_unbound",
      message:
        "deposit: pay_deposit moves money out of member, which is the member's account, but names programOperator as the source. Every run of this action would refuse with economic_source_unbound.",
    },
  ]);
});

// Mutation: suggest the first party parameter for every move, as r338 did,
// and pasting the warning's fix writes the broken refund back.
test("the purpose warning's fix for a refund out of held money names the company", () => {
  const warned = compile(deposit("", kept));
  expect(warned.warnings.map(({ fix }) => fix)).toEqual([
    "add economics refund_deposit { purpose: pass_through, sourceParty: programOperator } inside attach deposit",
  ]);
  const line = /economics [^}]+\}/.exec(warned.warnings[0]!.fix)![0];
  const pasted = compile(deposit(line, kept));
  expect(pasted.diagnostics).toEqual([]);
  expect(pasted.warnings).toEqual([]);
});

// Mutation: read only party.X sources, and a payment out of the member's own
// account field is told to name the company, which then fails check.
test("the purpose warning's fix for a payment out of a customer's account field names that customer", () => {
  const program = (economics: string) =>
    deposit("", kept)
      .replace(
        "    held: account of self\n",
        "    held: account of self\n    wallet: account of member\n",
      )
      .replace(
        "moves self.deposit from member to self.held",
        "moves self.deposit from self.wallet to self.held",
      )
      .replace(
        "economics pay_deposit { purpose: pass_through, sourceParty: member }",
        economics,
      );
  const warned = compile(program(""));
  expect(warned.warnings.map(({ fix }) => fix)).toContain(
    "add economics pay_deposit { purpose: pass_through, sourceParty: member } inside attach deposit",
  );
  const pasted = compile(
    program(
      "economics pay_deposit { purpose: pass_through, sourceParty: member }",
    ),
  );
  expect(pasted.diagnostics).toEqual([]);
});

// Mutation: drop the dotted-expose check. The error is "expected a name" again.
test("a child action exposed inside an attachment names the program-level form", () => {
  const desk = (
    inside: string,
    outside = "",
  ) => `program desk_and_key "Desk & Key"
use money

object desk "Desk" {
  fields { member: text }
  columns: [member]
  attach subscription = money.schedule {
    payer: owner, payee: operator, amount: 900 SAR, every: 1 month
    economics occurrence.pay { purpose: earning, sourceParty: payer }
    expose create as start_desk
    ${inside}
  }
}
${outside}`;
  const inside = compile(desk("expose occurrence.pay as pay_monthly_desk"));
  expect(inside.diagnostics.map((d) => [d.message, d.fix])).toEqual([
    [
      "expose inside an attachment takes one of its own actions, not occurrence.<action>",
      "delete this line, or expose a caller action of occurrence at program level: expose <object>.<attachment>.occurrence.<action> as <name>",
    ],
  ]);
  // occurrence.pay runs on the clock, so the program-level form says so and
  // deleting the line is the repair.
  const outside = compile(
    desk("", "expose desk.subscription.occurrence.pay as pay_monthly_desk"),
  );
  expect(outside.diagnostics.map((d) => d.message)).toEqual([
    "desk.subscription.occurrence.pay runs on the clock or its parent, not a caller",
  ]);
  expect(compile(desk("")).verdict).toBe("valid");
});
