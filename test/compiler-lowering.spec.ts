import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { headerManifest } from "../src/headers.ts";
import { runCli } from "../src/cli.ts";
import {
  objectProgrammeOptions,
  carsSource,
} from "./fixtures/object-programme.ts";

const header = `header custom
instrument review {
 lifecycle { states: [open], initial: open }
 action create {}
 action check { from: open, to: open }
}`;
const options = { standardLibrary: { source: () => header } };
const attach = (body: string) => `program p "P"
use custom
object application "Application" { attach review = custom.review { ${body} } }`;

// Mutation: append the instrument id to a generated action summary.
test("generated action summaries use only the action title", () => {
  const result = compile(attach(""), options);
  expect(result.verdict).toBe("valid");
  const actions = result.artifacts!.document.instruments[0]!.actions;
  expect(actions.check?.summary).toBe("Check");
});

// Mutation: remove udlInstrumentSchema checking before propagation and pruning.
test("malformed action and lifecycle shapes return diagnostics before traversal", () => {
  for (const [before, after, path] of [
    ["states: [open]", "states: open", "lifecycle.states"],
    ["initial: open", "initial: []", "lifecycle.initial"],
    [
      "action create {}",
      "action create { requires: {} }",
      "actions.create.requires",
    ],
    [
      "action create {}",
      "action create { invoke: [42] }",
      "actions.create.invoke",
    ],
    [
      "action create {}",
      'action create { actor: "nobody" }',
      "actions.create.actor",
    ],
  ]) {
    const changed = header.replace(before!, after!);
    const result = compile(
      'program p "P"\nuse custom\nreview = custom.review {}',
      {
        standardLibrary: { source: () => changed },
      },
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "UDL1003",
      source: "custom",
    });
    expect(result.diagnostics[0]?.message).toContain(path!);
  }
});

// Mutation: call data() on a scalar lifecycle and assign transitions to it.
test("a scalar lifecycle reports its source instead of throwing", () => {
  const changed = header.replace(
    "lifecycle { states: [open], initial: open }",
    "lifecycle: true",
  );
  expect(
    compile('program p "P"\nuse custom\nreview = custom.review {}', {
      standardLibrary: { source: () => changed },
    }).diagnostics,
  ).toMatchObject([
    { code: "HSX1001", source: "custom", message: "expected a block" },
  ]);
});

// Mutation: prune all unreachable actions, including misspelled source states.
test("invalid transitions survive lowering for the UDL3001 refusal", () => {
  const changed = header.replace("from: open", "from: typo");
  const result = compile(
    'program p "P"\nuse custom\nreview = custom.review {}',
    {
      standardLibrary: { source: () => changed },
    },
  );
  expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
    ["UDL3001", "$.instruments[0]: invalid transition check"],
  ]);
});

// Mutation: run lifecycle pruning even when no constant removes an action.
test("unreachable authored states are errors rather than discarded declarations", () => {
  const changed = header.replace("states: [open]", "states: [open, abandoned]");
  expect(
    compile('program p "P"\nuse custom\nreview = custom.review {}', {
      standardLibrary: { source: () => changed },
    }).diagnostics.map((d) => [d.code, d.message]),
  ).toEqual([["UDL3001", "$.instruments[0]: unreachable state abandoned"]]);
});

// Mutation: silently discard unknown/repeated exposure entries or overwrite renames.
test("attachment mappings refuse typos and repeated declarations at their source", () => {
  for (const [body, message] of [
    ["expose absent", "unknown or repeated action absent"],
    [
      "expose check as first expose check as second",
      "unknown or repeated action check",
    ],
    ["rename { value: first, value: second }", "duplicate rename value"],
  ] as const) {
    const result = compile(attach(body), options);
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["HSX1001", message],
    ]);
  }
  expect(
    compile(attach("expose check as inspect"), options).artifacts?.document
      .instruments[0]?.actions.check?.publicAction,
  ).toBe("inspect");
});

// Mutation: remove automatic-action rejection from attachment exposures.
test("attachment exposure rejects a clock action as top-level exposure does", () => {
  const result = compile(attach("expose check"), {
    standardLibrary: {
      source: () => header.replace("from: open", "actor: clock from: open"),
    },
  });
  expect(result.diagnostics.map((d) => d.message)).toEqual([
    "check runs on the clock or its parent, not a caller",
  ]);
});

// Mutation: remove the final availability check for an explicitly exposed action.
test("an exposed action removed by fixed bindings is diagnosed", () => {
  const changed = header.replace(
    "action check {",
    "action check { requires true == false",
  );
  const result = compile(attach("expose check"), {
    standardLibrary: { source: () => changed },
  });
  expect(result.diagnostics.map((d) => d.message)).toEqual([
    "action check is excluded by these bindings",
  ]);
});

// Mutation: look up declared parties through Object.prototype.
test("inherited object properties cannot satisfy a party binding", () => {
  const changed = header.replace(
    "instrument review {",
    "instrument review(payer: party) {",
  );
  const result = compile(attach("payer: constructor"), {
    standardLibrary: { source: () => changed },
  });
  expect(result.diagnostics.map((d) => d.code)).toEqual([
    "subject_party_unbound",
  ]);
});

// Mutation: use direct registry/operationMap lookup in subject declarations.
test("subject adapters ignore inherited registry entries and inherited operations", () => {
  const target = objectProgrammeOptions.adapterRegistry!.verification!;
  for (const registry of [
    Object.create({ verification: target }),
    {
      verification: {
        ...target,
        adapter: {
          ...target.adapter,
          operationMap: Object.create(target.adapter.operationMap),
        },
      },
    },
  ]) {
    const result = compile(carsSource, {
      ...objectProgrammeOptions,
      adapterRegistry: registry,
    });
    expect(result.diagnostics).toEqual([]);
    expect(
      result.artifacts?.document.instruments[0]?.actions.check?.subject
        ?.adapters,
    ).toEqual([{ binding: "verification", snapshot: null }]);
  }
});

// Mutation: accept a program or differently named header as imported metadata.
test("header metadata and compilation agree on header identity", () => {
  for (const source of [
    header.replace("header custom", 'program custom "Custom"'),
    header.replace("header custom", "header other"),
  ])
    expect(() => headerManifest({ source: () => source }, ["custom"])).toThrow(
      "custom: expected header custom",
    );
});

// Mutation: always print the program filename for an imported-source diagnostic.
test("CLI points header errors at the header rather than the supplied program", async () => {
  const errors: string[] = [];
  const code = await runCli(["check", "shop.hsx"], {
    out: () => {},
    err: (line) => errors.push(line),
    readFile: async () =>
      'program p "P"\nuse financing\nobject item "Item" { attach plan = financing.installments { disburse_to: borrower, months: 3, profit: 2% } }',
    writeFile: async () => {},
  });
  expect(code).toBe(1);
  expect(errors.find((line) => line.startsWith("financing:"))).toContain(
    "subject_party_unbound",
  );
});

// Mutation: stop invocation requirement propagation after 32 passes.
test("subject requirements reach the start of a long finite invocation chain", () => {
  const actions = Array.from(
    { length: 35 },
    (_, index) =>
      `action step${index} { from: open, to: open ${
        index === 34
          ? "subject { note: text }"
          : `invoke: [{ reference: self, action: step${index + 1}, input: {} }]`
      } }`,
  ).join("\n");
  const source = header.replace(
    "action check { from: open, to: open }",
    actions,
  );
  const result = compile(attach("expose step0"), {
    standardLibrary: { source: () => source },
  });
  expect(result.diagnostics).toEqual([]);
  expect(
    result.artifacts?.document.instruments[0]?.actions.step0?.subject
      ?.requirements,
  ).toEqual([{ field: { name: "note", type: "text" } }]);
});

// Mutation: replace the imported parser error with a generic error at the use line.
test("malformed imports preserve the header error and point back to the import", () => {
  const result = compile(attach(""), {
    standardLibrary: { source: () => "header custom instrument review {" },
  });
  expect(result.diagnostics).toMatchObject([
    {
      code: "HSX1000",
      source: "custom",
      message: "unclosed block, expected }",
      related: [{ source: "program", message: "Imported header custom" }],
    },
  ]);
});

// Mutation: validate reference parameters against already-lowered instruments only.
test("typed child references bind from declarations in either attachment order", () => {
  const source = `header custom
instrument producer {
 lifecycle { states: [open], initial: open }
 action create {}
 records { child: {
  lifecycle { states: [open], initial: open }
  action create {}
 } }
}
instrument consumer(target: ref<custom.producer.child>) {
 fields { link: ref<target> }
 lifecycle { states: [open], initial: open }
 action create {}
}`;
  const declarations = [
    "attach reader = custom.consumer { target: source.child }",
    "attach source = custom.producer {}",
  ];
  for (const rows of [declarations, [...declarations].reverse()]) {
    const result = compile(
      `program p "P" use custom object item { ${rows.join("\n")} }`,
      {
        standardLibrary: { source: () => source },
      },
    );
    expect(result.diagnostics).toEqual([]);
    expect(
      result.artifacts?.document.instruments.find(
        (item) => item.id === "item_reader",
      )?.fields,
    ).toEqual([
      {
        name: "link",
        type: "ref",
        targetKind: "instrument",
        target: "item_source_child",
      },
    ]);
  }
});

// Mutation: cast a numeric family target to string before resolving its declaration.
test("family selections reject non-name targets before family lookup", () => {
  const source = header
    .replace("instrument review {", "instrument review { familyRevision: 1")
    .replace(
      "action check {",
      `action check {
      invoke: [{ selection: { family: custom.review, instrument: 1, states: [open], limit: 1 }, action: check, input: {} }]`,
    );
  const result = compile(attach("expose check"), {
    standardLibrary: { source: () => source },
  });
  expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
    ["HSX1001", "instrument target needs a name"],
  ]);
});
