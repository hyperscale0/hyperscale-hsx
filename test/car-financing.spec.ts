import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile as compileHsx } from "../src/compile.ts";

// Read the owned std source; the committed bundle is regenerated from it.
const compile = (source: string) =>
  compileHsx(source, {
    standardLibrary: {
      source: (name) =>
        readFileSync(new URL(`../std/${name}.hsx`, import.meta.url), "utf8"),
    },
  });

const carFields = `fields { make: text, model: text, year: integer, vin: text, price: money }
  columns: [make, model, year, vin, price]`;

const minimalCarFinancing = `program car_financing "Car financing"
use escrow
use financing
object car "Car" {
  ${carFields}
  attach sale = escrow.hold { payer: actor, payee: operator }
  attach limits = financing.limits { borrower: actor, per_borrower: 250000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 10000000 SAR }
  attach plan = financing.installments {
    borrower: actor, capital: operator
    months: 36, profit: 8.5%, down_payment: 10%
    funds: sale, limits: limits, portfolio: ceiling
    expose create as finance
  }
}`;

const servicedCarFinancing = `program car_financing "Car financing"
use escrow
use financing
use collections
object car "Car" {
  ${carFields}
  attach sale = escrow.hold { payer: actor, payee: operator, expose fund as purchase }
  attach limits = financing.limits { borrower: actor, per_borrower: 250000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 10000000 SAR }
  attach plan = financing.installments {
    borrower: actor, capital: operator
    months: 36, profit: 8.5%, down_payment: 10%
    apply: fines_profit_principal, payoff_rebate: 100%, write_off_after: 90d
    funds: sale, limits: limits, portfolio: ceiling
    expose create as finance, expose sign as sign_contract, expose payoff as payoff
  }
  attach late = financing.late_charge {
    on: plan, grace: 3d, fine: 50 SAR, cap: 25 SAR
    fines_to: operator, costs_to: operator, borrower: actor
  }
  attach reminders = collections.reminder { on: plan, operator: operator, before_days: 3, overdue_days: 1 }
}`;

const institutionalCarFinancing = `program car_financing "Car financing"
use escrow
use financing
use collections
use insurance
object facility "Credit facility" {
  fields { name: text, limit: money }
  columns: [name, limit]
  attach line = financing.credit_line {
    borrower: operator, adapter: "funding_bank", limit: 50000000 SAR, expires: 2028-12-31
    expose activate as activate_facility
  }
  attach draw = financing.advance { line: line, expose draw as draw_capital }
}
object car "Car" {
  ${carFields}
  attach sale = escrow.hold { payer: actor, payee: operator, expose fund as purchase }
  attach limits = financing.limits { borrower: actor, per_borrower: 250000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 10000000 SAR }
  attach plan = financing.installments {
    borrower: actor, capital: operator
    months: 36, profit: 8.5%, down_payment: 10%
    funds: sale, limits: limits, portfolio: ceiling
    expose create as finance, expose sign as sign_contract, expose payoff as payoff
  }
  attach late = financing.late_charge {
    on: plan, grace: 3d, fine: 50 SAR, cap: 25 SAR
    fines_to: operator, costs_to: operator, borrower: actor
  }
  attach reminders = collections.reminder { on: plan, operator: operator, before_days: 3, overdue_days: 1 }
  attach auto_insurance = insurance.cover {
    holder: actor, adapter: "motor_insurer", covers: plan, premium: 3500 SAR
  }
}`;

const directCarLoan = `program car_loan "Car loan"
use financing
object car "Car" {
  ${carFields}
  attach limits = financing.limits { borrower: actor, per_borrower: 250000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 10000000 SAR }
  attach plan = financing.installments {
    borrower: actor, capital: operator
    months: 36, profit: 8.5%, down_payment: 10%, disburse_to: borrower
    expose create as finance
  }
}`;

const reportedCarFinancing = minimalCarFinancing
  .replace("use financing", "use financing\nuse reporting")
  .replace(/\}$/, "  attach book = reporting.portfolio { on: plan }\n}");

const valid = (name: string, source: string) => {
  const result = compile(source);
  if (result.diagnostics.length)
    throw new Error(`${name}: ${JSON.stringify(result.diagnostics)}`);
  return result.artifacts!.document;
};

test("the three car financing candidates compile against the standard library", () => {
  for (const [name, source] of [
    ["minimal", minimalCarFinancing],
    ["serviced", servicedCarFinancing],
    ["institutional", institutionalCarFinancing],
  ] as const)
    expect(valid(name, source).objects.length).toBeGreaterThan(0);
});

test("the portfolio ceiling is a sibling instrument, not a child record", () => {
  const document = valid("minimal", minimalCarFinancing);
  expect(document.instruments.map((item) => item.id)).toContain("car_ceiling");
  expect(
    document.instruments.find((item) => item.id === "car_plan")!.fields,
  ).toContainEqual({
    name: "portfolioLimit",
    type: "ref",
    target: "car_ceiling",
    targetKind: "instrument",
  });
});

test("a direct car loan needs no escrow hold and prices from the subject", () => {
  const plan = valid("direct", directCarLoan).instruments.find(
    (item) => item.id === "car_plan",
  )!;
  expect(plan.fields.map((field) => field.name)).not.toContain("funds");
  expect(plan.calculate.find((item) => item.target === "price")).toMatchObject({
    values: [{ field: "subject.price" }],
  });
});

test("outside institutions bind an adapter instead of a party account", () => {
  const document = valid("institutional", institutionalCarFinancing);
  const accounts = (id: string) =>
    document.instruments
      .find((item) => item.id === id)!
      .fields.filter((field) => field.type === "account")
      .map((field) => field.name);
  expect(accounts("facility_line")).toEqual(["borrower", "facility", "debt"]);
  expect(accounts("car_auto_insurance")).toEqual(["holder"]);
  expect(
    document.instruments.find((item) => item.id === "facility_line")!.actions
      .activate!.subject!.adapters,
  ).toEqual([{ binding: "funding_bank", snapshot: null }]);
  expect(
    document.instruments.find((item) => item.id === "car_auto_insurance")!
      .actions.activate!.subject!.adapters,
  ).toEqual([{ binding: "motor_insurer", snapshot: null }]);
});

test("a portfolio report compiles inside an object programme", () => {
  const report = valid("reported", reportedCarFinancing).instruments.find(
    (item) => item.id === "car_book",
  )!;
  expect(
    report.reports!.flatMap((entry) =>
      entry.datasets.map((dataset) => dataset.instruments),
    ),
  ).toContainEqual(["car_plan"]);
});
