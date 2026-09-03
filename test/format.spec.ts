import { describe, expect, it } from "bun:test";
import type { Program } from "../src/ast.ts";
import { format } from "../src/format.ts";
import { parseProgram } from "../src/parse.ts";

describe("format", () => {
  it("formats settlement sugar into the canonical instrument application", () => {
    const source = `program market "Market"
      import{held_payment,security_deposit}from"std/settlements"
      party buyer:person{country:"SA"}
      asset vehicle:good{title_transfer:off_platform}
      settlement sale=held_payment{payer:buyer payee:seller amount:price:money(SAR) on_cancel(funded){return_to:buyer}}
      port confirm_handover{allowed:[buyer,seller]}`;

    const result = format(source);

    expect(result).toEqual({
      formatted: `program market "Market";
import { held_payment, security_deposit } from "std/settlements";
party buyer: person {
  country: "SA";
}
asset vehicle: good {
  title_transfer: off_platform;
}
instrument sale = held_payment(payer: buyer, payee: seller, amount: price: money(SAR), on_cancel: {
  return_to: buyer;
});
port confirm_handover {
  allowed: [buyer, seller];
}
`,
      ok: true,
    });
    if (!result.ok) throw new Error("expected formatting to succeed");
    expect(withoutSpans(parseProgram(result.formatted).program)).toEqual(
      withoutSpans(parseProgram(source).program),
    );
  });

  it("formats general instruments with canonical clause spacing", () => {
    const source = `module std.payments
      export type Currency=SAR
      export const fee:bps=25
      export instrument held_payment<C>(payer:party,payee:party,amount:money<C>){
        fields{amount:stored_amount:money<C>}
        lifecycle{states draft funded released;initial draft;parked draft reason "awaiting funds";on fund:draft->funded;on release:funded|draft->released}
        parties{payer:payer payee:payee}
        action fund{requires refs:[payer] computes remainder{from:amount} notify payee via sms moves{amount:amount}}
      }
      export instrument sale=std.payments.held_payment<SAR>(buyer,seller,SAR 500.00)`;

    const result = format(source);

    expect(result).toEqual({
      formatted: `module std.payments;
export type Currency = SAR;
export const fee: bps = 25;
export instrument held_payment<C>(payer: party, payee: party, amount: money<C>) {
  fields {
    amount: stored_amount: money<C>;
  }
  lifecycle {
    states draft funded released;
    initial draft;
    parked draft reason "awaiting funds";
    on fund: draft -> funded;
    on release: funded | draft -> released;
  }
  parties {
    payer: payer;
    payee: payee;
  }
  action fund {
    requires refs: [payer];
    computes remainder {
      from: amount;
    }
    notify payee via sms;
    moves {
      amount: amount;
    }
  }
}
export instrument sale = std.payments.held_payment<SAR>(buyer, seller, SAR 500.00);
`,
      ok: true,
    });
    if (!result.ok) throw new Error("expected formatting to succeed");
    expect(withoutSpans(parseProgram(result.formatted).program)).toEqual(
      withoutSpans(parseProgram(source).program),
    );
  });

  it("is idempotent", () => {
    const first = format(
      `instrument transfer{lifecycle{states ready done;initial ready;on send:ready->done}action send{notify payee via webhook}}`,
    );
    if (!first.ok) throw new Error("expected first formatting pass to succeed");

    expect(format(first.formatted)).toEqual(first);
  });

  it("retains leading, trailing, and nested line comments", () => {
    const source = `// Product identity
program market "Market" // stable public name
instrument transfer { // lifecycle follows
  // One bounded transition
  lifecycle { states ready done; initial ready; on send: ready -> done }
  action send { notify payee via webhook } // priced effect
}
// End of file
`;

    const result = format(source);

    expect(result).toEqual({
      formatted: `// Product identity
program market "Market"; // stable public name
instrument transfer {
  // lifecycle follows
  // One bounded transition
  lifecycle {
    states ready done;
    initial ready;
    on send: ready -> done;
  }
  action send {
    notify payee via webhook;
  } // priced effect
}
// End of file
`,
      ok: true,
    });
    if (!result.ok) throw new Error("expected comment formatting to succeed");
    expect(format(result.formatted)).toEqual(result);
  });

  it("formats bounded comprehensions and indexed names", () => {
    const result = format(
      `instrument schedule{for installment in 3{action pay_[installment]{summary:"Pay {installment}" steps:[]}}}`,
    );

    expect(result).toEqual({
      formatted: `instrument schedule {
  for installment in 3 {
    action pay_[installment] {
      summary: "Pay {installment}";
      steps: [];
    }
  }
}
`,
      ok: true,
    });
  });

  it("returns parser diagnostics without printing a partial program", () => {
    const result = format("instrument broken {");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected formatting to fail");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("block never closes");
  });
});

function withoutSpans(value: Program): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (key === "span" ? undefined : item)),
  );
}
