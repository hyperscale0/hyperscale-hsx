import { readFileSync } from "node:fs";
import { compile } from "../../src/compile.ts";

export const standardLibrary = {
  source: (name: string) =>
    readFileSync(new URL(`../../std/${name}.hsx`, import.meta.url), "utf8"),
};

export function document(source: string) {
  const result = compile(source, { standardLibrary });
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  return result.artifacts.document;
}

export function instrument(source: string, id: string) {
  const found = document(source).instruments.find((item) => item.id === id);
  if (!found) throw new Error(`Missing instrument ${id}`);
  return found;
}

export const financing = `program checkout "Checkout"
use financing
use escrow
object purchase "Purchase" {
 attach sale = escrow.hold {
  payer: actor, payee: owner
  expose create as order, expose cancel as cancel_checkout
  expose dispute as dispute_order, expose verify_return as verify_return
  expose refund as refund_order
 }
 attach limits = financing.limits { borrower: actor, per_borrower: 10000 SAR }
 attach ceiling = financing.portfolio_limit { limit: 100000 SAR }
 attach plan = financing.installments {
  borrower: actor, capital: operator, months: 4, profit: 0%, down_payment: 25%
  funds: sale, limits: limits, portfolio: ceiling
  expose create as finance, expose sign as sign_offer
  expose collect_down_payment as checkout, expose disburse as disburse
 }
 attach late = financing.late_charge {
  on: plan, borrower: actor, fine: 40 SAR, grace: 7d
  expose create as propose_assessment
 }
}`;
