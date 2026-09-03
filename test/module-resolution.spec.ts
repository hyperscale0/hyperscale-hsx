import { describe, expect, it } from "bun:test";
import { parseProgram } from "../src/index.ts";
import { compile } from "./compile.ts";
import { resolveProgramModules } from "../src/modules.ts";

const simpleTemplate = `export instrument simple_template() {
  title: "Simple";
  fields {}
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}`;

function resolver(modules: Readonly<Record<string, string>>) {
  return (specifier: string) => {
    const source = modules[specifier];
    return source ? { name: specifier, source } : undefined;
  };
}

function emittedInstrument(
  result: ReturnType<typeof compile>,
  id: string,
): Record<string, unknown> | undefined {
  const instruments = result.artifacts?.document.instruments;
  return Array.isArray(instruments)
    ? (instruments.find(
        (instrument) =>
          instrument &&
          typeof instrument === "object" &&
          "id" in instrument &&
          instrument.id === id,
      ) as Record<string, unknown> | undefined)
    : undefined;
}

describe("module resolution", () => {
  it("names a module and its own coordinates for an imported diagnostic", () => {
    const result = compile(
      `program imported_error "Imported error"
import { ready } from "broken"
`,
      {
        resolveModule() {
          return {
            name: "broken.hsx",
            source: `module broken
export instrument ready {
 title: "Ready"; fields {}
 lifecycle { states created; initial created; }
 action create { public: wrong; steps: []; }
}`,
          };
        },
      },
    );

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics[0]).toMatchObject({
      code: "HSX1501",
      column: 18,
      file: "broken.hsx",
      line: 5,
      message:
        "action clause public does not exist in the targeted UDL vocabulary",
    });
  });

  it("carries a module-local decision port with an exported application", () => {
    const result = compile(
      `program imported_application "Imported application"
import { ready } from "decision"
`,
      {
        resolveModule(specifier) {
          return {
            name: specifier,
            source: `module decision
port local_release { allowed: [payer] }
export instrument decision_template(release: condition) {
  fields {}
  lifecycle { states created released; initial created; on [release]: created -> released; }
  action create { moves: []; steps: []; }
  action [release] { port: { allowed_parties: release_allowed; }; moves: []; steps: []; }
}
export instrument ready = decision_template(release: port local_release)
`,
          };
        },
      },
    );

    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts?.document).toMatchObject({
      instruments: [
        {
          actions: {
            local_release: { port: { allowedParties: ["payer"] } },
          },
          id: "ready",
        },
      ],
    });
  });

  it("rejects one imported symbol exported by two modules", () => {
    const result = compile(
      `program duplicate_import "Duplicate import"
import { shared } from "first"
import { shared } from "second"
instrument item {
  title: shared;
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`,
      {
        resolveModule(specifier) {
          return {
            name: specifier,
            source: `module ${specifier}\nexport const shared: text = "${specifier}"`,
          };
        },
      },
    );

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1006",
        message: "imported name shared is exported by more than one module",
      }),
    );
  });

  it("rejects an importer declaration that collides with a carried port", () => {
    const result = compile(
      `program collision "Collision"
party payer: person
port local_release { allowed: [payer] }
import { ready } from "decision"
`,
      {
        resolveModule: resolver({
          decision: `module decision
party beneficiary: person
port local_release { allowed: [beneficiary] }
export instrument decision_template(release: condition) {
  fields {}
  lifecycle { states created released; initial created; on [release]: created -> released; }
  action create { moves: []; steps: []; }
  action [release] { port: { allowed_parties: release_allowed; }; moves: []; steps: []; }
}
export instrument ready = decision_template(release: port local_release)
`,
        }),
      },
    );

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1009",
        message:
          "imported application ready carries module-local port local_release, which collides with an importer-owned declaration",
      }),
    );
  });

  it("does not leak an unused module declaration", () => {
    const parsed = parseProgram(`program no_leak "No leak"
import { ready } from "private"
`);
    const result = resolveProgramModules(parsed.program, {
      resolveModule: resolver({
        private: `module private
party unused_party: person
${simpleTemplate}
export instrument ready = simple_template()
`,
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.program.decls.some(
        (decl) => decl.kind === "party" && decl.name.name === "unused_party",
      ),
    ).toBe(false);
  });

  it("keeps equal private port names in separate application scopes", () => {
    const module = (name: string, party: string) => `module ${name}
party ${party}: person
port private_release { allowed: [${party}] }
export instrument private_template(release: condition) {
  fields {}
  lifecycle { states created released; initial created; on [release]: created -> released; }
  action create { moves: []; steps: []; }
  action [release] { port: { allowed_parties: release_allowed; }; moves: []; steps: []; }
}
export instrument ${name}_ready = private_template(release: port private_release)
`;
    const result = compile(
      `program separate_scopes "Separate scopes"
import { first_ready } from "first"
import { second_ready } from "second"
`,
      {
        resolveModule: resolver({
          first: module("first", "payer"),
          second: module("second", "beneficiary"),
        }),
      },
    );

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      instruments: [
        {
          actions: {
            private_release: { port: { allowedParties: ["payer"] } },
          },
          id: "first_ready",
        },
        {
          actions: {
            private_release: { port: { allowedParties: ["beneficiary"] } },
          },
          id: "second_ready",
        },
      ],
    });
  });

  it("unifies an identical importer and carried declaration", () => {
    const result = compile(
      `program identical_party "Identical party"
party payer: person
import { ready } from "identical"
`,
      {
        resolveModule: resolver({
          identical: `module identical
party payer: person
export instrument party_template(member: party) {
  title: words(member);
  fields {}
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
export instrument ready = party_template(member: payer)
`,
        }),
      },
    );

    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(emittedInstrument(result, "ready")).toMatchObject({
      id: "ready",
      title: "payer",
    });
  });

  it("does not carry a party mentioned only as a role or interpolation", () => {
    const parsed = parseProgram(`program isolated_role "Isolated role"
party holder: organization
import { ready } from "isolated"
`);
    const result = resolveProgramModules(parsed.program, {
      resolveModule: resolver({
        isolated: `module isolated
party holder: person
export instrument held_template() {
  title: "Held by {holder}";
  fields { holderAccountId { type: text; } }
  lifecycle { states created; initial created; }
  parties { holder: holderAccountId; }
  action create { moves: []; steps: []; }
}
export instrument ready = held_template()
`,
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ready = result.program.decls.find(
      (decl) => decl.kind === "instrument_apply" && decl.name.name === "ready",
    );
    expect(
      ready?.kind === "instrument_apply" ? ready.declarationScope : undefined,
    ).not.toContainEqual(
      expect.objectContaining({
        kind: "party",
        name: expect.objectContaining({ name: "holder" }),
      }),
    );
  });

  it("preserves importer authorization when the module port is unused", () => {
    const result = compile(
      `program reviewer_probe "Reviewer probe"
party payer: person
port local_release { allowed: [payer] }
import { ready } from "unrelated"
instrument local_template(release: condition) {
  fields {}
  lifecycle { states created released; initial created; on [release]: created -> released; }
  action create { moves: []; steps: []; }
  action [release] { port: { allowed_parties: release_allowed; }; moves: []; steps: []; }
}
instrument local_hold = local_template(release: port local_release)
`,
      {
        resolveModule: resolver({
          unrelated: `module unrelated
party beneficiary: person
port local_release { allowed: [beneficiary] }
${simpleTemplate}
export instrument ready = simple_template()
`,
        }),
      },
    );

    expect(result.verdict).toBe("valid");
    expect(emittedInstrument(result, "local_hold")).toMatchObject({
      actions: {
        local_release: { port: { allowedParties: ["payer"] } },
      },
      id: "local_hold",
    });
  });

  it("carries a module-local constant used by an application", () => {
    const result = compile(
      `program constant_scope "Constant scope"
import { ready } from "constant"
`,
      {
        resolveModule: resolver({
          constant: `module constant
const local_title: text = "Ready from module"
export instrument titled_template() {
  title: local_title;
  fields {}
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
export instrument ready = titled_template()
`,
        }),
      },
    );

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      instruments: [{ id: "ready", title: "Ready from module" }],
    });
  });

  it("carries a module-local constant used in a computed key", () => {
    const result = compile(
      `program computed_key "Computed key"
import { ready } from "computed"
`,
      {
        resolveModule: resolver({
          computed: `module computed
const field_name: text = amount
export instrument computed_template() {
  fields { [field_name] { type: text; } }
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
export instrument ready = computed_template()
`,
        }),
      },
    );

    expect(result.verdict).toBe("valid");
    expect(emittedInstrument(result, "ready")).toMatchObject({
      fields: { amount: { type: "string" } },
      id: "ready",
    });
  });

  it("carries a zero-parameter template used by an application", () => {
    const result = compile(
      `program zero_template "Zero template"
import { ready } from "zero"
`,
      {
        resolveModule: resolver({
          zero: `module zero
${simpleTemplate}
export instrument ready = simple_template()
`,
        }),
      },
    );

    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts?.document).toMatchObject({
      instruments: [{ id: "ready", title: "Simple" }],
    });
  });

  it("carries a module-local type used by an application template", () => {
    const result = compile(
      `program local_type "Local type"
import { ready } from "typed"
`,
      {
        resolveModule: resolver({
          typed: `module typed
type SaudiMoney = money<SAR>
export instrument typed_template(amount: SaudiMoney) {
  fields { amount: SaudiMoney; }
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
export instrument ready = typed_template(amount: SAR 1.00)
`,
        }),
      },
    );

    expect(result.verdict).toBe("valid");
    expect(emittedInstrument(result, "ready")).toMatchObject({
      fields: {
        amount: { pattern: "^[1-9][0-9]{0,17}$", type: "string" },
      },
      id: "ready",
    });
  });

  it("gives an imported concrete instrument its declaration closure", () => {
    const source = `module concrete
const local_title: text = "Concrete from module"
type LocalAmount = money<SAR>
export instrument ready {
  title: local_title;
  fields { amount: LocalAmount; }
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
`;
    const direct = compile(source);
    const imported = compile(
      `program concrete "Concrete"
import { ready } from "concrete"
`,
      { resolveModule: resolver({ concrete: source }) },
    );

    expect(direct.verdict).toBe("valid");
    expect(imported.verdict).toBe("valid");
    expect(imported.artifacts?.document).toEqual(direct.artifacts?.document);
    expect(emittedInstrument(imported, "ready")).toMatchObject({
      fields: {
        amount: { pattern: "^[1-9][0-9]{0,17}$", type: "string" },
      },
      id: "ready",
      title: "Concrete from module",
    });
  });

  it("carries declarations imported by the exporting module", () => {
    const result = compile(
      `program transitive_scope "Transitive scope"
import { ready } from "application"
`,
      {
        resolveModule: resolver({
          application: `module application
import { dependency_template } from "dependency"
export instrument ready = dependency_template()
`,
          dependency: `module dependency
const dependency_title: text = "Transitive title"
export instrument dependency_template() {
  title: dependency_title;
  fields {}
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
`,
        }),
      },
    );

    expect(result.verdict).toBe("valid");
    expect(emittedInstrument(result, "ready")).toMatchObject({
      id: "ready",
      title: "Transitive title",
    });
  });

  it("emits the same canonical UDL directly and through an import", () => {
    const source = `module equality
const local_title: text = "Equal application"
export instrument equality_template(label: text) {
  title: local_title;
  fields {}
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
export instrument ready = equality_template(label: "unused")
`;
    const direct = compile(source);
    const imported = compile(
      `program equality "Equality"
import { ready } from "equality"
`,
      { resolveModule: resolver({ equality: source }) },
    );

    expect(direct.verdict).toBe("valid");
    expect(imported.verdict).toBe("valid");
    expect(imported.artifacts?.document).toEqual(direct.artifacts?.document);
    expect(emittedInstrument(imported, "ready")).toMatchObject({
      id: "ready",
      title: "Equal application",
    });
  });

  it("never emits a zero-parameter template without an application", () => {
    const source = `module zero_equality
${simpleTemplate}
export instrument ready = simple_template()
`;
    const direct = compile(source);
    const imported = compile(
      `program zero_equality "Zero equality"
import { ready } from "zero_equality"
`,
      { resolveModule: resolver({ zero_equality: source }) },
    );

    expect(direct.verdict).toBe("valid");
    expect(imported.verdict).toBe("valid");
    expect(emittedInstrument(direct, "simple_template")).toBeUndefined();
    expect(emittedInstrument(direct, "ready")).toBeDefined();
    expect(imported.artifacts?.document).toEqual(direct.artifacts?.document);
  });
});
