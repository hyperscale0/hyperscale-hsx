import type { UdlDocument } from "@hyperscale0/udl";
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "./compile.ts";

it("six-slice obligations retain every delinquency state and reject remarking the same slice", () => {
  const source = readFileSync(
    join(import.meta.dir, "fixtures/mandated-obligation.hsx"),
    "utf8",
  ).replace("count: 2", "count: 6");
  const result = compile(source);
  const obligation = (
    result.artifacts?.document as UdlDocument | undefined
  )?.instruments.find((item) => item.id === "obligation");
  expect(
    obligation?.lifecycle.transitions.mark_installment_6_delinquent,
  ).toEqual({
    from: [
      "active",
      "installment_1_delinquent",
      "installment_2_delinquent",
      "installment_3_delinquent",
      "installment_4_delinquent",
      "installment_5_delinquent",
    ],
    to: "installment_6_delinquent",
  });
});
