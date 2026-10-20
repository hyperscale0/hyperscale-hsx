import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";

const parties = (source: string) => {
  const result = compile(source);
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  return Object.fromEntries(
    result.artifacts.document.objects.flatMap((object) =>
      object.attachments.map((attachment) => [
        attachment.name,
        attachment.parties,
      ]),
    ),
  );
};
const codes = (source: string) =>
  compile(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
  ]);

const bike = (
  bindings: string,
  extra = "",
) => `program bikes "Kettle & Co bikes"
object bike "Bike sale" {
  fields { make: text, model: text, price: money }${extra}
  attach sale = escrow.hold {
    ${bindings}
    fee: { seller: 5%, tax: 0% }
    expose create as start_sale
    expose fund as pay
    expose deliver as mark_ready
    expose accept as confirm_collection
  }
}`;

// Baseline run 4 of the bike brief: the buyer owned the record, the seller
// dropped out, and the company kept the whole price. Mutation: delete the
// companyFees call in compile.ts and this compiles clean.
test("a seller fee on money paid to the company itself never compiles", () => {
  expect(codes(bike("payer: owner, payee: operator"))).toEqual([
    [
      "fee_on_company_sale",
      "sale: accept and settle_release charge the 5% seller fee on payee's share, but payee is bound to the company itself, so no payee is paid and the company keeps the whole price.",
    ],
  ]);
  // With no seller fee the company is the seller, as in a shop's own stock.
  expect(
    compile(
      bike("payer: owner, payee: operator").replace("seller: 5%", "seller: 0%"),
    ).verdict,
  ).toBe("valid");
});

// Mutation: drop the create pin from the starter choice in bindings.ts and
// the seller and buyer swap between runs that order the rows differently.
test("the bike sale binds the buyer as actor and the seller as owner", () => {
  const expected = {
    payer: { role: "actor" as const },
    payee: { role: "owner" as const },
  };
  expect(parties(bike("payer: customer, payee: customer")).sale).toEqual(
    expected,
  );
  expect(parties(bike("payee: customer, payer: customer")).sale).toEqual(
    expected,
  );
  // An unbound payer takes its party(person) default and is a customer too.
  expect(parties(bike("payee: customer")).sale).toEqual(expected);
  expect(
    parties(
      bike(
        "payer: customer, payee: customer",
        "\n  entryActions: [start_sale]",
      ),
    ).sale,
  ).toEqual(expected);
  expect(parties(bike("payer: actor, payee: owner")).sale).toEqual(expected);
});

// The bike build Architect made on r372 listed no entry action, so the buyer
// its create runs for could neither read nor start the seller's sale.
// Mutation: drop the placed-starter push in placeCustomers.
test("a placed starter's create is an entry action, a hand-written actor's is not", () => {
  const entries = (source: string) =>
    compile(source).artifacts!.document.objects[0]!.entryActions;
  expect(entries(bike("payer: customer, payee: customer"))).toEqual([
    "start_sale",
  ]);
  expect(
    entries(
      bike(
        "payer: customer, payee: customer",
        "\n  entryActions: [start_sale]",
      ),
    ),
  ).toEqual(["start_sale"]);
  expect(entries(bike("payer: actor, payee: owner"))).toBeUndefined();
  // A company's car with no entry list: the renter books it as actor.
  expect(
    entries(
      fleet("  belongs_to: company\n").replace(
        "  entryActions: [book_car]\n",
        "",
      ),
    ),
  ).toEqual(["book_car"]);
});

// The r373 stage build: Architect hand-wrote the escrow as a program
// instrument whose create names no actor. The rule placed the paying buyer on
// actor and the actor rule gave it the create, yet entryActions stayed empty,
// and listing the create by hand put both customers on owner (HSX1001).
// Mutation: read only a header's written create actor in placeCustomers.
test("a program instrument's paying buyer opens its create on the seller's record", () => {
  const sale = (
    create: string,
    bindings: string,
    extra = "",
  ) => `program kettle "Kettle & Co"
instrument bike_escrow(buyer: party, seller: party) {
  fields { held: account of self, price: money = subject.price, fee: money = rate(self.price, 5%) }
  lifecycle { states: [pending, funded, collected], initial: pending }
  ${create}
  action collect {
    from: funded, to: collected
    moves self.fee from self.held to programOperator
    moves self.held.balance from self.held to seller
  }
}
object bike_listing "Bike listing" {
  fields { title: text, price: money }${extra}
  attach escrow = bike_escrow {
    ${bindings}
    rename { price: price }
    expose create as pay_for_bike
    expose collect as confirm_collection
  }
}`;
  const paysOnCreate = `action create {
    subject { price: money }
    moves self.price from buyer to self.held
  }
  action ready { from: pending, to: funded }`;
  const paysLater = `action create { subject { price: money } }
  action pay { from: pending, to: funded, moves self.price from buyer to self.held }`;
  const built = (source: string) => {
    const result = compile(source);
    if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
    const object = result.artifacts.document.objects[0]!;
    return {
      entryActions: object.entryActions,
      parties: object.attachments[0]!.parties,
      actor: result.artifacts.document.instruments[0]!.actions.create!.actor,
    };
  };
  const open = {
    entryActions: ["pay_for_bike"],
    parties: {
      buyer: { role: "actor" as const },
      seller: { role: "owner" as const },
    },
    actor: { party: "actor" },
  };
  const customers = "buyer: customer, seller: customer";
  expect(built(sale(paysOnCreate, customers))).toEqual(open);
  expect(built(sale(paysLater, customers))).toEqual(open);
  expect(
    built(sale(paysOnCreate, customers, "\n  entryActions: [pay_for_bike]")),
  ).toEqual(open);
  // A role written by hand stays closed.
  expect(
    built(sale(paysOnCreate, "buyer: actor, seller: owner")).entryActions,
  ).toBeUndefined();
});

// Mutation: skip the agreement check on hand-written roles.
test("a hand-written binding that breaks the rule names both sides", () => {
  expect(codes(bike("payer: owner, payee: actor"))).toEqual([
    [
      "customer_binding_rule",
      "sale: `payer: owner` breaks the binding rule. In sale, create runs for payer, so payer starts it and binds actor.",
    ],
    [
      "customer_binding_rule",
      "sale: `payee: actor` breaks the binding rule. In sale, create runs for payer, so payee owns the record and binds owner.",
    ],
  ]);
});

test("a lending product binds the borrower as the record's owner", () => {
  const bound = parties(`program homes "Homes"
object home "Home" {
  fields { price: money }
  attach limits = financing.limits { borrower: customer, per_borrower: 2000000 SAR }
  attach book = financing.portfolio_limit { limit: 50000000 SAR }
  attach plan = financing.installments {
    borrower: customer, capital: operator, pricing: amortizing, profit_rate: 5%
    disburse_to: borrower, limits: limits, portfolio: book
    expose create as quote_mortgage
    expose sign as sign_mortgage
    expose disburse as fund_mortgage
  }
}`);
  expect(bound.limits).toEqual({ borrower: { role: "owner" } });
  expect(bound.plan).toMatchObject({
    borrower: { role: "owner" },
    capital: { role: "operator" },
  });
});

test("a deposit product binds the holder as the record's owner", () => {
  expect(
    parties(`program savings "Savings"
object account "Account" {
  fields { name: text }
  attach purse = wallet.balance {
    holder: customer
    expose create as open_wallet
    expose topup as add_funds
  }
}`).purse,
  ).toEqual({ holder: { role: "owner" } });
});

const fleet = (marker: string) => `program fleet "City car hire"
object car "Car" {
${marker}  entryActions: [book_car]
  fields { make: text, plate: text }
  attach hire = rental.hire_charge {
    renter: customer, security: security
    expose create as book_car
  }
  attach security = rental.deposit { renter: customer, hire: hire }
}`;

// Mutation: ignore belongs_to in compile.ts and the renter owns the car.
test("a company-owned rental car binds its renter as actor", () => {
  expect(parties(fleet("  belongs_to: company\n"))).toEqual({
    hire: { renter: { role: "actor" } },
    security: { renter: { role: "actor" } },
  });
  // The entry action alone places only the hire's own customer.
  expect(parties(fleet(""))).toEqual({
    hire: { renter: { role: "actor" } },
    security: { renter: { role: "owner" } },
  });
  expect(codes(fleet("  belongs_to: renter\n"))).toEqual([
    ["HSX1001", "belongs_to takes company"],
  ]);
});

// The bakery owns its funding record; each investor enters through an entry
// action on a record they do not own.
test("investors who enter a borrower's round bind actor beside an owner borrower", () => {
  const bound = parties(
    readFileSync(new URL("../examples/lending.hsx", import.meta.url), "utf8"),
  );
  expect(bound.loan).toMatchObject({ borrower: { role: "owner" } });
  expect(bound.investor_balance).toEqual({ holder: { role: "actor" } });
  expect(bound.investment).toEqual({ investor: { role: "actor" } });
});

test("customer is a binding, never a party name", () => {
  expect(
    codes(`program shop "Shop"
party customer: business
object order "Order" {
  fields { item: text }
  attach pay = money.transfer { payer: customer, payee: operator, amount: 10 SAR }
}`)[0]?.[0],
  ).toBe("party_name_reserved");
});

// Review P1: an unbound person-default parameter that shares a declared
// party's name binds that party by name, never a customer role. Mutation: drop
// the byName test in placeCustomers and borrower binds the record's owner.
test("a declared party keeps its by-name binding", () => {
  const bound = parties(`program shop "Shop"
party borrower: business
object shop "Shop" {
  fields { name: text }
  attach limits = financing.limits { per_borrower: 1000 SAR }
}`);
  expect(bound.limits).toEqual({ borrower: { party: "borrower" } });
});

// Review P2: the economics source names the parameter, so it follows the
// placed role. Mutation: resolve sourceParty before placement and a company
// car's renter pays while the books name the record's owner.
test("an economics source named by parameter follows the placed role", () => {
  const source = (marker: string) =>
    compile(`program fleet "Fleet"
object car "Car" {
${marker}  fields { plate: text }
  attach rent = money.transfer {
    payer: customer, payee: operator, amount: 100 SAR
    economics pay { purpose: earning, sourceParty: payer }
  }
}`)
      .artifacts!.document.instruments.find((item) => item.id === "car_rent")!
      .actions.pay!.moves.map((move) => move.economics?.sourceParty);
  expect(source("  belongs_to: company\n")).toEqual(["actor"]);
  expect(source("")).toEqual(["owner"]);
});

const stall = (marker: string) => `program stall "Market stall"
object stall "Stall" {
${marker}  fields { item: text }
  attach listing = marketplace.listing {
    seller: customer
    expose create as list_item
    expose publish as publish_item
  }
  attach order = marketplace.order {
    listing: listing, buyer: customer
    expose create as place_order
    expose commit as commit_order
  }
}`;

// A buyer and a seller on sibling attachments would both bind owner, one
// person on both sides of the money. Mutation: drop the owners check in
// placeCustomers and the stall compiles with buyer and seller both owner.
test("two customers no rule places refuse instead of sharing owner", () => {
  expect(codes(stall(""))).toEqual([
    [
      "customer_binding_rule",
      "stall: seller on listing and buyer on order are customers no rule places, so both would bind owner and one person would take both sides of the money.",
    ],
  ]);
  expect(parties(stall("  entryActions: [place_order]\n"))).toMatchObject({
    listing: { seller: { role: "owner" } },
    order: { buyer: { role: "actor" } },
  });
  // One name on several attachments is one customer, as lending's borrower
  // on allowance, loan and round.
  const lending = parties(
    readFileSync(new URL("../examples/lending.hsx", import.meta.url), "utf8"),
  );
  expect(lending.allowance).toEqual({ borrower: { role: "owner" } });
  expect(lending.funding).toMatchObject({ borrower: { role: "owner" } });
});
