export interface HsxDiagnosticCatalogEntry {
  readonly code: `HSX${number}`;
  readonly stage: "bind" | "lower" | "parse" | "typecheck";
  readonly title: string;
  readonly fix: string;
  readonly example: string | null;
  readonly reason?: string;
}

const instrument = (
  body: string,
): string => `program catalog_probe "Catalog probe"
instrument probe {
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
  ${body}
}`;

/** Stable public descriptions for every diagnostic code emitted by HSX. */
export const hsxDiagnostics: readonly HsxDiagnosticCatalogEntry[] = [
  {
    code: "HSX1000",
    stage: "typecheck",
    title: "Missing file declaration",
    fix: "Add one program header or module declaration.",
    example: "",
  },
  {
    code: "HSX1001",
    stage: "bind",
    title: "Unbound name",
    fix: "Declare or import the name before using it.",
    example:
      'program catalog_probe "Catalog probe"\ninstrument probe = missing()',
  },
  {
    code: "HSX1002",
    stage: "typecheck",
    title: "Duplicate program declaration",
    fix: "Keep exactly one program declaration.",
    example: `${instrument("")}\nprogram second "Second"`,
  },
  {
    code: "HSX1003",
    stage: "typecheck",
    title: "Invalid declaration name",
    fix: "Use lowercase snake_case for program and instrument names.",
    example: 'program NotSnake "Catalog probe"',
  },
  {
    code: "HSX1004",
    stage: "typecheck",
    title: "Duplicate declaration",
    fix: "Keep one declaration or give each declaration a distinct name.",
    example: `${instrument("")}\ninstrument probe { fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }`,
  },
  {
    code: "HSX1005",
    stage: "typecheck",
    title: "Invalid field name",
    fix: "Rename the field in lower camelCase.",
    // The parser normalizes every accepted source field spelling to lower camelCase.
    example: null,
    reason:
      "The parser normalizes every accepted field spelling before typechecking.",
  },
  {
    code: "HSX1006",
    stage: "bind",
    title: "Invalid module import",
    fix: "Resolve one module that exports each imported name exactly once.",
    // A source string cannot control the compiler host's module resolver.
    example: null,
    reason: "This refusal requires a compiler-host module resolver result.",
  },
  {
    code: "HSX1007",
    stage: "typecheck",
    title: "Invalid cross-instrument reference",
    fix: "Name an existing target instrument in the ref type.",
    example: `program catalog_probe "Catalog probe"
instrument probe {
  fields { parentId { type: ref; description: "Parent"; } }
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`,
  },
  {
    code: "HSX1008",
    stage: "typecheck",
    title: "Invalid subject or decision port",
    fix: "Complete the declaration and bind every referenced decision port.",
    example: `${instrument("")}\nsubject vehicle { title: "Vehicle"; }`,
  },
  {
    code: "HSX1009",
    stage: "bind",
    title: "Imported declaration collision",
    fix: "Rename the importer-owned declaration or the module-local declaration.",
    // A source string cannot create a collision in a compiler-host module result.
    example: null,
    reason:
      "This refusal requires declarations returned by a compiler-host module resolver.",
  },
  {
    code: "HSX1010",
    stage: "typecheck",
    title: "Wrong type-argument count",
    fix: "Supply exactly the type arguments declared by the instrument function.",
    example: `program catalog_probe "Catalog probe"
export instrument template<C>() { fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }
instrument probe = template<SAR, USD>()`,
  },
  {
    code: "HSX1011",
    stage: "typecheck",
    title: "Missing required argument",
    fix: "Pass every required instrument-function argument.",
    example: `program catalog_probe "Catalog probe"
export instrument template(value: text) { fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }
instrument probe = template()`,
  },
  {
    code: "HSX1012",
    stage: "typecheck",
    title: "Unknown named argument",
    fix: "Remove the argument or use a parameter declared by the instrument function.",
    example: `program catalog_probe "Catalog probe"
export instrument template() { fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }
instrument probe = template(typo: true)`,
  },
  {
    code: "HSX1013",
    stage: "typecheck",
    title: "Duplicate named argument",
    fix: "Pass each named argument once.",
    example: `program catalog_probe "Catalog probe"
export instrument template(value: text) { fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }
instrument probe = template(value: "one", value: "two")`,
  },
  {
    code: "HSX1014",
    stage: "parse",
    title: "JSON supplied as HSX",
    fix: "Replace the JSON object with HSX declarations.",
    example: '{ "hsx": 1 }',
  },
  {
    code: "HSX1015",
    stage: "typecheck",
    title: "Invalid composed program identity",
    fix: "Give the composed program a bounded product id and title.",
    // This diagnostic requires a compiler-host published catalog.
    example: null,
    reason: "This refusal requires a compiler-host published catalog.",
  },
  {
    code: "HSX1016",
    stage: "typecheck",
    title: "Empty published composition",
    fix: "Select at least one published instrument with use.",
    // This diagnostic requires a compiler-host published catalog.
    example: null,
    reason: "This refusal requires a compiler-host published catalog.",
  },
  {
    code: "HSX1017",
    stage: "typecheck",
    title: "Duplicate published instrument",
    fix: "Keep one use declaration for each published instrument.",
    // This diagnostic requires a compiler-host published catalog.
    example: null,
    reason: "This refusal requires a compiler-host published catalog.",
  },
  {
    code: "HSX1018",
    stage: "typecheck",
    title: "Unavailable published instrument",
    fix: "Use an instrument id from the supplied published catalog.",
    example: 'program catalog_probe "Catalog probe"\nuse missing',
  },
  {
    code: "HSX1020",
    stage: "typecheck",
    title: "Invalid public action name",
    fix: "Expose each action once under a distinct lower camelCase name.",
    // This diagnostic requires a compiler-host published catalog.
    example: null,
    reason: "This refusal requires a compiler-host published catalog.",
  },
  {
    code: "HSX1021",
    stage: "typecheck",
    title: "Invalid exposed action",
    fix: "Expose an action on an explicitly used published instrument.",
    // This diagnostic requires a compiler-host published catalog.
    example: null,
    reason: "This refusal requires a compiler-host published catalog.",
  },
  {
    code: "HSX1022",
    stage: "typecheck",
    title: "Authored instrument in a composition",
    fix: "Publish the instrument separately, then select it with use.",
    // This diagnostic requires a compiler-host published catalog.
    example: null,
    reason: "This refusal requires a compiler-host published catalog.",
  },
  {
    code: "HSX1023",
    stage: "typecheck",
    title: "Invalid required-field list",
    fix: "List declared, non-optional field names once each.",
    example: instrument("required: missing;"),
  },
  {
    code: "HSX1101",
    stage: "typecheck",
    title: "Currency mismatch",
    fix: "Use the declared currency because money values never coerce.",
    example: `${instrument("")}\nconst fee: money<SAR> = USD 1.00`,
  },
  {
    code: "HSX1102",
    stage: "typecheck",
    title: "Money precision exceeds minor units",
    fix: "Round the literal to the currency's minor-unit precision.",
    example: `${instrument("")}\nconst fee: money<SAR> = SAR 1.001`,
  },
  {
    code: "HSX1103",
    stage: "typecheck",
    title: "Invalid numeric value",
    fix: "Use an integer, percent, bps, or valid fixed-money binding.",
    example: instrument("summary: 1.5;"),
  },
  {
    code: "HSX1104",
    stage: "typecheck",
    title: "Value has the wrong type",
    fix: "Pass the type declared by the parameter or UDL slot.",
    example: instrument("summary: money(SAR, 2500);"),
  },
  {
    code: "HSX1110",
    stage: "typecheck",
    title: "Unsupported parameter combination",
    fix: "Choose a supported compile-time parameter combination.",
    example: `program catalog_probe "Catalog probe"
export instrument template() {
  unsupported { message: "Not supported"; fix: "Choose another form"; }
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
}
instrument probe = template()`,
  },
  {
    code: "HSX1201",
    stage: "typecheck",
    title: "Linear money consumed more than once",
    fix: "Leave exactly one sink for each produced money value.",
    example: instrument(`fields { amount: money<SAR>; }
action pay { computes remainder rest { amount_ref: total; on_zero: refuse; total_path: fields.amount; }; moves: [{ amount: rest; }, { amount: rest; }]; }`),
  },
  {
    code: "HSX1202",
    stage: "typecheck",
    title: "Linear money is unconsumed",
    fix: "Route each produced money value to one explicit sink.",
    example: instrument(`fields { amount: money<SAR>; }
action pay { computes remainder rest { amount_ref: total; on_zero: refuse; total_path: fields.amount; }; }`),
  },
  {
    code: "HSX1301",
    stage: "typecheck",
    title: "Missing cost-table price",
    fix: "Supply a versioned cost table with a row for every emitted effect.",
    example: instrument(""),
  },
  {
    code: "HSX1302",
    stage: "typecheck",
    title: "Invalid cost-table row",
    fix: "Use non-negative integer prices and a supported settlement timing.",
    // A source string cannot make the compiler host's cost table malformed.
    example: null,
    reason: "This refusal requires a malformed compiler-host cost table.",
  },
  {
    code: "HSX1303",
    stage: "typecheck",
    title: "Invalid cost-table currency",
    fix: "Use the supported uppercase cost-table currency.",
    // A source string cannot change the compiler host's cost-table currency.
    example: null,
    reason:
      "This refusal requires an invalid compiler-host cost-table currency.",
  },
  {
    code: "HSX1401",
    stage: "typecheck",
    title: "Unbounded action",
    fix: "Replace runtime iteration with a bounded compile-time comprehension.",
    example: instrument("action run { while { condition: true; }; }"),
  },
  {
    code: "HSX1402",
    stage: "typecheck",
    title: "Missing lifecycle",
    fix: "Declare lifecycle states and an initial state.",
    example:
      'program catalog_probe "Catalog probe"\ninstrument probe { fields {}; action create { steps: []; }; }',
  },
  {
    code: "HSX1403",
    stage: "typecheck",
    title: "Runtime comprehension bound",
    fix: "Use an integer literal or literal finite list as the bound.",
    example: `program catalog_probe "Catalog probe"
export instrument template(count: integer) {
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
  for item in count { action run_[item] { steps: []; } }
}
instrument probe = template(count: runtimeCount: integer)`,
  },
  {
    code: "HSX1404",
    stage: "typecheck",
    title: "Comprehension expansion limit",
    fix: "Reduce the fixed expansion to the compiler limit.",
    example: instrument("for item in 257 { action run_[item] { steps: []; } }"),
  },
  {
    code: "HSX1405",
    stage: "typecheck",
    title: "Invalid compile-time selection",
    fix: "Give compile-time conditions and unsupported branches fixed blocks.",
    example: `program catalog_probe "Catalog probe"
export instrument template() { unsupported: true; fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }
instrument probe = template()`,
  },
  {
    code: "HSX1406",
    stage: "typecheck",
    title: "Invalid companion instrument",
    fix: "Construct each companion with a compile-time id.",
    example: `program catalog_probe "Catalog probe"
export instrument template() {
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
  instruments { invalid: true; }
}
instrument probe = template()`,
  },
  {
    code: "HSX1501",
    stage: "typecheck",
    title: "Unknown UDL clause",
    fix: "Use a clause exported by the targeted UDL vocabulary.",
    example: instrument("unknown_clause: true;"),
  },
  {
    code: "HSX1502",
    stage: "typecheck",
    title: "Program emits no instruments",
    fix: "Declare or instantiate at least one instrument.",
    example: 'program catalog_probe "Catalog probe"',
  },
  {
    code: "HSX1503",
    stage: "typecheck",
    title: "Missing fields block",
    fix: "Add a fields block, even when it is empty.",
    example:
      'program catalog_probe "Catalog probe"\ninstrument probe { lifecycle { states created; initial created; }; action create { steps: []; }; }',
  },
  {
    code: "HSX1504",
    stage: "typecheck",
    title: "Missing create action",
    fix: "Add an action create block.",
    example:
      'program catalog_probe "Catalog probe"\ninstrument probe { fields {}; lifecycle { states created; initial created; }; }',
  },
  {
    code: "HSX1505",
    stage: "typecheck",
    title: "Repeated single-valued clause",
    fix: "Keep one occurrence of the clause.",
    example: instrument('title: "First"; title: "Second";'),
  },
  {
    code: "HSX1506",
    stage: "typecheck",
    title: "Conflicting public action settings",
    fix: "Keep either public: none or a public action name.",
    example: instrument(
      "action finish { public: none; public_action: finishProbe; steps: []; }",
    ),
  },
  {
    code: "HSX1507",
    stage: "typecheck",
    title: "Invalid application metadata",
    fix: "Keep contract mechanics in the parameterized instrument.",
    example: `program catalog_probe "Catalog probe"
export instrument template() { fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }
instrument probe = template() { fields: {}; }`,
  },
  {
    code: "HSX1601",
    stage: "lower",
    title: "Invalid UDL shape",
    fix: "Correct the named clause so it matches the targeted UDL definition.",
    // A source program cannot bypass the typechecker to emit an invalid UDL shape.
    example: null,
    reason:
      "Typed source cannot bypass the checker to emit an invalid UDL shape.",
  },
  {
    code: "HSX1602",
    stage: "lower",
    title: "Invalid UDL semantics",
    fix: "Correct the named clause so it satisfies the targeted UDL law.",
    // A source program cannot bypass the typechecker to emit invalid UDL semantics.
    example: null,
    reason:
      "Typed source cannot bypass the checker to emit invalid UDL semantics.",
  },
  {
    code: "HSX1603",
    stage: "lower",
    title: "Unresolved compiler marker",
    fix: "Correct compile-time block keys or parameter bindings.",
    example: instrument('title: "__hsx_none__";'),
  },
] as const;
