import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { Entry } from "../src/ast.ts";
import { catalogProgramSource } from "../src/catalog-program.ts";
import { compile } from "../src/compile.ts";
import { parseProgram } from "../src/parse.ts";
import { defaultToolchain } from "../src/toolchain.ts";

// The actor rule fills every action that names no actor from its money and
// its record (src/actors.ts). These programs name no actor at all, as the
// Architect writes them.
const actors = (source: string) => {
  const result = compile(source);
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  return Object.fromEntries(
    result.artifacts.document.instruments.flatMap((instrument) =>
      instrument.actionOrder.map((name) => [
        `${instrument.id}.${name}`,
        instrument.actions[name]!.actor,
      ]),
    ),
  );
};
const company = { party: "programOperator" };
const actor = { party: "actor" };
const owner = { party: "owner" };

const bike = `program kettle "Kettle & Co"

instrument sale(buyer: party, seller: party) {
  fields { held: account of self, price: money, fee: money = rate(self.price, 5%), payout: money = subtract(self.price, self.fee) }
  lifecycle { states: [started, paid, ready, collected, refunded, cancelled], initial: started }
  action create {}
  action pay { from: started, to: paid, moves self.price from buyer to self.held }
  action mark_ready { from: paid, to: ready }
  action confirm_collection {
    from: ready, to: collected
    moves self.payout from self.held to seller
    moves self.fee from self.held to programOperator
  }
  action refund { from: [paid, ready], to: refunded, moves self.held.balance from self.held to buyer }
  action cancel { from: started, to: cancelled }
}

object bike "Bike" {
  fields { make: text, price: money }
  attach sale = sale {
    buyer: actor, seller: owner
    rename { price: price }
    expose create as start_sale
    expose pay as pay_for_bike
    expose mark_ready as mark_ready_for_collection
    expose confirm_collection as confirm_collection
    expose refund as refund_buyer
    expose cancel as cancel_sale
  }
}`;

const lending = `program lender "Lender"

instrument loan(borrower: party) {
  fields { principal: money, decidedAt: date? }
  lifecycle { states: [applied, approved, active, repaid, declined, written_off], initial: applied }
  action create {}
  action approve { from: applied, to: approved, set: { decidedAt: { field: self.now } } }
  action decline { from: applied, to: declined }
  action disburse { from: approved, to: active, moves self.principal from programOperator to borrower }
  action repay { from: active, to: repaid, moves self.principal from borrower to programOperator }
  action write_off { from: active, to: written_off }
}

object application "Loan application" {
  fields { purpose: text, principal: money }
  attach loan = loan {
    borrower: owner
    rename { principal: principal }
    expose create as apply
    expose approve as approve_loan
    expose decline as decline_loan
    expose disburse as disburse_loan
    expose repay as repay_loan
    expose write_off as write_off_loan
  }
}`;

const deposit = `program savings "Savings"

instrument deposit(holder: party) {
  fields { held: account of self, amount: money, maturesAt: date }
  lifecycle { states: [opened, funded, withdrawn, matured], initial: opened }
  action create {}
  action pay_in { from: opened, to: funded, moves self.amount from holder to self.held }
  action withdraw { from: funded, to: withdrawn, moves self.held.balance from self.held to holder }
  action mature { from: funded, to: matured, due: { at: self.maturesAt }, moves self.held.balance from self.held to holder }
}

object account "Savings account" {
  fields { nickname: text, amount: money, maturesAt: date }
  attach deposit = deposit {
    holder: owner
    rename { amount: amount, maturesAt: maturesAt }
    expose create as open_deposit
    expose pay_in as pay_in
    expose withdraw as withdraw
  }
}`;

// Mutation: give create to the owner while a party binds actor, give a
// no-money step to the record owner, or give held money to its payer. The
// seller would start the buyer's sale, and a program-local release would wait
// on the buyer. A founder who wants the buyer to press it sets it in Build.
test("the bike marketplace: the buyer starts and pays, the company does the rest", () => {
  expect(actors(bike)).toEqual({
    "bike_sale.create": actor,
    "bike_sale.pay": actor,
    "bike_sale.mark_ready": company,
    "bike_sale.confirm_collection": company,
    "bike_sale.refund": company,
    "bike_sale.cancel": company,
  });
});

// Mutation: give a no-money step on an owned record to its owner. The
// borrower could approve or write off its own loan.
test("a lending product: the borrower applies and repays, the company decides and disburses", () => {
  expect(actors(lending)).toEqual({
    "application_loan.create": owner,
    "application_loan.approve": company,
    "application_loan.decline": company,
    "application_loan.disburse": company,
    "application_loan.repay": owner,
    "application_loan.write_off": company,
  });
});

// Mutation: give a release of held money to the party who paid it in. The
// renter would have to forfeit its own deposit, and the buyer would decide the
// dispute it lost.
test("held money that leaves to anyone but its payer is the company's", () => {
  const rental = `program rentals "Rentals"

instrument deposit(renter: party) {
  fields { held: account of self, amount: money }
  lifecycle { states: [opened, funded, kept, returned], initial: opened }
  action create {}
  action pay_in { from: opened, to: funded, moves self.amount from renter to self.held }
  action keep_deposit { from: funded, to: kept, subject { damageNotes: text }, moves self.held.balance from self.held to programOperator }
  action return_deposit { from: funded, to: returned, moves self.held.balance from self.held to renter }
}

object booking "Booking" {
  fields { amount: money }
  attach deposit = deposit {
    renter: owner
    rename { amount: amount }
    expose create as open_deposit
    expose pay_in as pay_deposit
    expose keep_deposit as keep_deposit
    expose return_deposit as return_deposit
  }
}`;
  expect(actors(rental)).toMatchObject({
    "booking_deposit.pay_in": owner,
    "booking_deposit.keep_deposit": company,
    "booking_deposit.return_deposit": company,
  });
  const disputed = bike
    .replace("collected, refunded,", "collected, disputed, resolved, refunded,")
    .replace(
      "  action cancel {",
      "  action dispute { from: ready, to: disputed }\n  action resolve_for_seller { from: disputed, to: resolved, moves self.held.balance from self.held to seller }\n  action cancel {",
    )
    .replace(
      "    expose cancel as cancel_sale",
      "    expose cancel as cancel_sale\n    expose resolve_for_seller as resolve_for_seller",
    );
  expect(actors(disputed)["bike_sale.resolve_for_seller"]).toEqual(company);
});

// Mutation: check the due rule before the money. The company could move money
// out of the borrower's account, and the borrower's own session is refused.
test("a due repay from the borrower's account is the borrower's", () => {
  const due = lending
    .replace("decidedAt: date? }", "decidedAt: date?, dueAt: date }")
    .replace(
      "action repay { from: active, to: repaid,",
      "action repay { from: active, to: repaid, due: { at: self.dueAt },",
    )
    .replace(
      "rename { principal: principal }",
      "rename { principal: principal, dueAt: dueAt }",
    )
    .replace(
      "{ purpose: text, principal: money }",
      "{ purpose: text, principal: money, dueAt: date }",
    );
  expect(actors(due)["application_loan.repay"]).toEqual(owner);
});

// Mutation: rule an action only an invoke reaches. The customer's pay invokes
// confirm, and a confirm given to the company refuses the customer's chain.
test("an action only an invoke reaches keeps caller", () => {
  const chained = bike.replace(
    "action pay { from: started, to: paid, moves self.price from buyer to self.held }",
    "action pay { from: started, to: paid, moves self.price from buyer to self.held, invoke: [{ reference: self.id, action: confirm, input: {} }] }\n  action confirm { from: paid, to: paid }",
  );
  const ruled = actors(chained);
  expect(ruled["bike_sale.confirm"]).toBe("caller");
  expect(ruled["bike_sale.pay"]).toEqual(actor);
});

// Mutation: match an invoke on its action name alone. The loan's repay
// invokes its own close, and membership's due close, which nothing presses or
// invokes, would wait on a caller and never run.
test("an invoke reaches the action of the instrument it targets", () => {
  const club = lending.replace(
    "action repay { from: active, to: repaid, moves self.principal from borrower to programOperator }",
    "action repay { from: active, to: repaid, moves self.principal from borrower to programOperator, invoke: [{ reference: self.id, action: close, input: {} }] }\n  action close { from: repaid, to: repaid }",
  ).concat(`

instrument membership(member: party) {
  fields { held: account of self, fee: money, endsAt: date }
  lifecycle { states: [joined, paid, closed], initial: joined }
  action create {}
  action pay { from: joined, to: paid, moves self.fee from member to self.held }
  action close { from: paid, to: closed, due: { at: self.endsAt }, moves self.held.balance from self.held to programOperator }
}

object club "Club" {
  fields { fee: money, endsAt: date }
  attach membership = membership {
    member: owner
    rename { fee: fee, endsAt: endsAt }
    expose create as join
    expose pay as pay_fee
  }
}`);
  const ruled = actors(club);
  expect(ruled["club_membership.close"]).toBe("clock");
  expect(ruled["application_loan.close"]).toBe("caller");
});

// Mutation: read only attach-block expose lines in the clock check. A due
// step with no input that a program-level expose names would go to the clock
// and fail its own expose line.
test("a due step a program-level expose names is pressed, not clock-run", () => {
  const result = compile(`${deposit}
expose account.deposit.mature as mature`);
  expect(result.diagnostics).toEqual([]);
  const mature = result.artifacts!.document.instruments.find(
    (instrument) => instrument.id === "account_deposit",
  )!.actions.mature!;
  expect(mature.actor).toEqual(company);
  expect(mature.publicAction).toBe("mature");
});

// Mutation: drop the due rule, or count money returned to its payer as spent.
test("a deposit product: the holder opens and pays in, the company pays out, the clock matures", () => {
  expect(actors(deposit)).toEqual({
    "account_deposit.create": owner,
    "account_deposit.pay_in": owner,
    "account_deposit.withdraw": company,
    "account_deposit.mature": "clock",
  });
});

// Mutation: send every due action to the clock. The clock supplies no
// subject and presses no public action, so a late step someone records or
// presses would never run, and its expose line would not compile.
test("a due step someone records or presses is the company's, not the clock's", () => {
  const recorded = deposit.replace(
    "due: { at: self.maturesAt },",
    "due: { at: self.maturesAt }, subject { maturityNote: text },",
  );
  expect(actors(recorded)["account_deposit.mature"]).toEqual(company);
  const pressed = deposit.replace(
    "expose withdraw as withdraw",
    "expose withdraw as withdraw\n    expose mature as mature",
  );
  expect(actors(pressed)["account_deposit.mature"]).toEqual(company);
});

// Mutation: run the rule on an instrument that names no party. Programs
// written before the rule, with no party to give a step to, would hand every
// step to the company.
test("an instrument with no party parameter keeps caller", () => {
  const unparted = deposit
    .replace("instrument deposit(holder: party) {", "instrument deposit() {")
    .replaceAll(" to holder", " to programOperator")
    .replaceAll("from holder", "from programOperator")
    .replace("    holder: owner\n", "");
  expect(new Set(Object.values(actors(unparted)))).toEqual(new Set(["caller"]));
});

// Mutation: let the rule overwrite a written actor.
test("an explicit actor wins over the rule", () => {
  const explicit = deposit.replace(
    "action withdraw { from: funded",
    "action withdraw { actor: { party: holder }, from: funded",
  );
  expect(actors(explicit)["account_deposit.withdraw"]).toEqual(owner);
  const caller = lending.replace(
    "action write_off { from",
    "action write_off { actor: caller, from",
  );
  expect(actors(caller)["application_loan.write_off"]).toBe("caller");
});

// Mutation: let one party run an action that spends two parties' money.
test("an action that spends two parties' money names no actor and is refused", () => {
  const swap = bike.replace(
    "action cancel { from: started, to: cancelled }",
    "action cancel { from: started, to: cancelled, moves self.price from buyer to seller, moves self.price from seller to buyer }",
  );
  const result = compile(swap);
  expect(result.verdict).toBe("invalid");
  expect(result.diagnostics[0]!.message).toContain(
    "cancel spends money of actor and owner",
  );
});

// Mutation: let the rule reach a std action. Releasing held money after a
// dispute is the company's decision, while the rule alone would give it to
// the payer whose money it is.
test("escrow settle release stays the company's", () => {
  const result = compile(`program p "P"
object bike "Bike" {
  fields { price: money }
  attach sale = escrow.hold { payer: actor, payee: owner, rename { price: price } }
}`);
  const hold = result.artifacts!.document.instruments.find(
    (instrument) => instrument.id === "bike_sale",
  )!;
  expect(hold.actions.settle_release!.actor).toEqual(company);
  expect(hold.actions.accept!.actor).toEqual(actor);
});

// Mutation: drop an actor from any std action. The rule would then decide it
// and the std authority design would move under every Product.
test("every std action names its actor", () => {
  const missing: string[] = [];
  const visit = (header: string, name: string, entries: readonly Entry[]) => {
    for (const row of entries) {
      if (row.key === "records" && row.value.kind === "block")
        for (const record of row.value.entries)
          if (record.value.kind === "block")
            visit(header, `${name}.${record.key}`, record.value.entries);
      if (
        row.key.startsWith("action ") &&
        row.value.kind === "block" &&
        !row.value.entries.some((entry) => entry.key === "actor")
      )
        missing.push(`${header}: ${name}.${row.key.slice(7)}`);
    }
  };
  for (const [header, source] of defaultToolchain.std)
    for (const decl of parseProgram(source).program.decls)
      if ("body" in decl) visit(header, decl.name, decl.body.entries);
  expect(missing).toEqual([]);
});

// The catalog program attaches every std template. This digest is its UDL
// from before the actor rule; `actor: caller` in std keeps every byte. A
// deliberate std change re-pins it.
test("the std catalog compiles to the same UDL as before the actor rule", () => {
  const document = compile(catalogProgramSource).artifacts!.document;
  expect(
    createHash("sha256").update(JSON.stringify(document)).digest("hex"),
  ).toBe("3aa8e8968425e6e0d582d17898d66c49557a498a97a757904463816bce259ef3");
});
