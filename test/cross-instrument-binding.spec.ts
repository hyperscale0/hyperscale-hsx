import { describe, expect, it } from "bun:test";
import { checkGeneralProgram } from "../src/index.ts";
import { resolveProgramModules } from "../src/modules.ts";
import { parseProgram } from "../src/parse.ts";

const TARGETS = `module catalog.targets
export instrument child {
  fields { parentId: ref<parent>; amount: money<SAR>; reason: text; }
  lifecycle { states open closed; initial open; }
  action create { steps: []; moves: []; }
}
export instrument limit {
  fields { cap: money<SAR>; }
  required: [cap];
  lifecycle { states open; initial open; }
  action create { steps: []; moves: []; }
}`;

function check(source: string, targets = TARGETS) {
  const parsed = parseProgram(source);
  expect(parsed.diagnostics).toEqual([]);
  const resolved = resolveProgramModules(parsed.program, {
    resolveModule(specifier) {
      return specifier === "catalog/targets"
        ? { name: specifier, source: targets }
        : undefined;
    },
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(resolved.issues[0]?.message);
  return checkGeneralProgram(resolved.program);
}

const ROOT = `program cross_binding "Cross binding"
import { child, limit } from "catalog/targets"
instrument parent {
  fields {
    targetAmount: money<SAR>;
    amount: money<SAR>;
    limitId: ref<limit>;
    settleBy: date;
  }
  lifecycle { states open closed; initial open; }
  aggregate_invariants: [{
    childField: "amount";
    childInstrumentId: "child";
    childRefField: "parentId";
    childStatuses: ["open"];
    parentField: "targetAmount";
  }];
  action create {
    steps: [];
    moves: [];
    reconcile: {
      amount: "fields.amount";
      capture: evidenceId;
      counterpartyRef: payoutId;
      currencyField: currency;
      direction: debit;
      evidence: statement_line;
      exception: { amountField: amount; childInstrumentId: child; maxOpen: 1; reasonField: reason; refField: parentId; };
      match: { law: exact; };
      within: { field: settleBy; };
    };
    requires_aggregate: [{
      check: { amountField: "amount"; kind: "sum_at_least"; targetField: "targetAmount"; };
      instrumentId: "child";
      over: "children";
      refField: "parentId";
      statuses: ["open"];
    }];
    requires_exposure: [{
      amountField: "amount";
      anchorField: "limitId";
      capField: "cap";
      capOnAnchor: true;
      childInstrumentId: "parent";
      statuses: ["open"];
    }];
    computes signed_sum {
      amountRef: "netAmount";
      onNegative: "refuse";
      onZero: "refuse";
      sources: [{
        amountField: "amount";
        instrumentId: "child";
        refField: "parentId";
        sign: "add";
        statuses: ["open"];
        subtotalRef: "childTotal";
      }];
    }
  }
}`;

describe("cross-instrument field binding", () => {
  it("binds action and aggregate child fields after module resolution", () => {
    const checked = check(ROOT);

    expect(
      checked.diagnostics.filter(({ code }) => code === "HSX1007"),
    ).toEqual([]);
  });

  it("reports an unresolved action target at the authored clause", () => {
    const source = ROOT.replace(
      'instrumentId: "child";',
      'instrumentId: "missing";',
    );
    const checked = check(source);
    const diagnostic = checked.diagnostics.find(
      ({ code, message }) => code === "HSX1007" && message.includes("missing"),
    );

    expect(diagnostic).toBeDefined();
    expect(diagnostic?.span.end).toBeGreaterThan(diagnostic?.span.start ?? 0);
    expect(
      source.slice(diagnostic?.span.start, diagnostic?.span.end).length,
    ).toBeGreaterThan(0);
  });

  it("checks aggregate invariant fields on the imported child", () => {
    const checked = check(
      ROOT.replace('childField: "amount";', 'childField: "missingAmount";'),
    );

    expect(checked.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1007",
        message: expect.stringContaining("child.missingAmount"),
      }),
    );
  });

  it.each([
    ["amountField", "missingAmount"],
    ["reasonField", "missingReason"],
  ] as const)("reports a missing reconcile exception %s", (key, field) => {
    const checked = check(
      ROOT.replace(
        `${key}: ${key === "amountField" ? "amount" : "reason"};`,
        `${key}: ${field};`,
      ),
    );

    expect(checked.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1007",
        message: expect.stringContaining(
          `reconcile exception ${key} names child.${field}, which does not exist`,
        ),
      }),
    );
  });

  it.each([
    ["amountField", "reason", "money<C>"],
    ["reasonField", "amount", "text"],
  ] as const)(
    "reports a mistyped reconcile exception %s",
    (key, field, expected) => {
      const checked = check(
        ROOT.replace(
          `${key}: ${key === "amountField" ? "amount" : "reason"};`,
          `${key}: ${field};`,
        ),
      );

      expect(checked.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HSX1007",
          message: expect.stringContaining(
            `reconcile exception ${key} names child.${field}, which has`,
          ),
          fix: expect.stringContaining(expected),
        }),
      );
    },
  );

  it.each([
    ["amountField", "amount", "money<SAR>"],
    ["reasonField", "reason", "text"],
  ] as const)(
    "reports an optional reconcile exception %s",
    (key, field, type) => {
      const optionalTargets = TARGETS.replace(
        `${field}: ${type};`,
        `${field} { type: ${type}; optional: true; }`,
      );
      const checked = check(ROOT, optionalTargets);

      expect(checked.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HSX1007",
          message: expect.stringContaining(
            `reconcile exception ${key} names child.${field}, which is optional; exception fields must be required`,
          ),
          fix: expect.stringContaining("child required list"),
        }),
      );

      const omittedTargets = TARGETS.replace(
        "action create { steps: []; moves: []; }",
        `required: [parentId, ${field === "amount" ? "reason" : "amount"}];\n  action create { steps: []; moves: []; }`,
      );
      const checkedOmitted = check(ROOT, omittedTargets);

      expect(checkedOmitted.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HSX1007",
          message: expect.stringContaining(
            `reconcile exception ${key} names child.${field}, which is optional; exception fields must be required`,
          ),
          fix: expect.stringContaining("child required list"),
        }),
      );
    },
  );

  it("reports a constrained reasonField for currency rather than reporting it optional", () => {
    const checked = check(
      ROOT.replace("reasonField: reason;", "reasonField: currency;"),
    );

    expect(checked.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1007",
        message: expect.stringContaining(
          "reason field child.currency carries a pattern constraint",
        ),
      }),
    );
    expect(checked.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: "HSX1007",
        message: expect.stringContaining("which is optional"),
      }),
    );
  });

  it("admits an explicitly required text field as reasonField", () => {
    const explicitTargets = TARGETS.replace(
      "action create { steps: []; moves: []; }",
      "required: [parentId, amount, reason];\n  action create { steps: []; moves: []; }",
    );
    const checked = check(ROOT, explicitTargets);

    expect(
      checked.diagnostics.filter(({ code }) => code === "HSX1007"),
    ).toEqual([]);
  });

  it.each([
    [
      "pattern",
      'reason { type: text; pattern: "^[a-z]+$"; }',
      "a pattern constraint",
    ],
    [
      "format",
      'reason { type: text; format: "email"; }',
      "a format constraint",
    ],
    [
      "enum",
      'reason { type: text; enum: ["failed", "disputed"]; }',
      "an enum constraint",
    ],
    ["const", 'reason { type: text; const: "fixed"; }', "a const constraint"],
  ] as const)(
    "reports a constrained reconcile exception reasonField with %s",
    (_kind, reasonDecl, wording) => {
      const constrainedTargets = TARGETS.replace("reason: text;", reasonDecl);
      const checked = check(ROOT, constrainedTargets);

      expect(checked.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HSX1007",
          message: expect.stringContaining(
            `reason field child.reason carries ${wording}`,
          ),
        }),
      );
    },
  );

  it("admits a reasonField with minLength and maxLength bounds", () => {
    const boundedTargets = TARGETS.replace(
      "reason: text;",
      "reason { type: text; minLength: 1; maxLength: 180; }",
    );
    const checked = check(ROOT, boundedTargets);

    expect(
      checked.diagnostics.filter(({ code }) => code === "HSX1007"),
    ).toEqual([]);
  });
});
