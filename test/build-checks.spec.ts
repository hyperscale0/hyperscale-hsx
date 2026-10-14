import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { canonicalJson } from "@hyperscale0/udl";
import { compile } from "../src/compile.ts";

const wallet = readFileSync(
  new URL(
    "../../../toolchain/scenarios/ladder/1-a-wallet/company.hsx",
    import.meta.url,
  ),
  "utf8",
);
const program = wallet.slice(0, wallet.indexOf("\ncheck ")).trimEnd() + "\n";
const checks = `
check "Pays and returns" {
  customer alice "Alice Turner" funded 100 SAR
  customer oliver "Oliver Reed"
  object payment: payment for oliver { reference: "P2P-001" }
  alice payment.agree -> pending
  alice payment.pay -> paid balances { alice: 0 SAR, oliver: 100 SAR }
  expect balances { alice: 0 SAR, oliver: 100 SAR, operator: 0 SAR }
    held 0 SAR
}
check "Expects too much" {
  customer alice "Alice Turner" funded 100 SAR
  customer oliver "Oliver Reed"
  object payment: payment for oliver { reference: "P2P-002" }
  alice payment.agree -> pending
  alice payment.pay -> paid
  expect balances { oliver: 200 SAR }
}
`;

test("checks sit beside the document and never change it", () => {
  const bare = compile(program);
  const checked = compile(program + checks);
  expect(checked.diagnostics).toEqual([]);
  expect(canonicalJson(checked.artifacts!.document)).toBe(
    canonicalJson(bare.artifacts!.document),
  );
  expect(bare.artifacts!.checks).toEqual([]);
  expect(checked.artifacts!.checks.map((check) => check.name)).toEqual([
    "Pays and returns",
    "Expects too much",
  ]);
  expect(checked.artifacts!.checks[0]).toEqual({
    name: "Pays and returns",
    customers: [
      { id: "alice", name: "Alice Turner", fund: "10000" },
      { id: "oliver", name: "Oliver Reed" },
    ],
    steps: [
      {
        kind: "object",
        id: "payment",
        objectKind: "payment",
        owner: "oliver",
        fields: { reference: "P2P-001" },
      },
      {
        kind: "action",
        object: "payment",
        action: "agree",
        actor: "alice",
        state: "pending",
      },
      {
        kind: "action",
        object: "payment",
        action: "pay",
        actor: "alice",
        state: "paid",
        expected: { alice: "0", oliver: "10000" },
      },
    ],
    expected: { alice: "0", oliver: "10000", operator: "0" },
    expectedHeld: "0",
  });
});

test("a check naming an undeclared action fails at that step", () => {
  const source = `${program}
check "Typo" {
  customer alice "Alice Turner" funded 100 SAR
  object payment: payment for alice
  alice payment.agre -> pending
  expect balances { alice: 100 SAR }
}
`;
  const result = compile(source);
  expect(result.verdict).toBe("invalid");
  const [diagnostic] = result.diagnostics;
  expect(diagnostic!.message).toBe(
    "payment action agre is not declared. Did you mean `agree`?",
  );
  expect(source.slice(diagnostic!.span.start, diagnostic!.span.end)).toBe(
    "agre",
  );
  expect(diagnostic!.line).toBe(
    source.slice(0, source.indexOf("agre ")).split("\n").length,
  );
});

test("an unknown object kind or customer fails at its step", () => {
  const unknown = (step: string) =>
    compile(`${program}
check "Unknown" {
  customer alice "Alice Turner"
  ${step}
  expect balances { alice: 0 SAR }
}
`).diagnostics[0]!.message;
  expect(unknown("object payment: parcel for alice")).toBe(
    "object kind parcel is not declared.",
  );
  expect(unknown("object payment: payment for bob")).toBe(
    "customer bob is not declared.",
  );
  expect(unknown("clock 2031-04-01 until payment is paid")).toBe(
    "object payment is not declared.",
  );
});
