import { describe, expect, it } from "bun:test";
import { serializeUdl, type UdlDocument } from "@hyperscale0/udl";
import { format, parseProgram } from "../src/index.ts";
import { compile } from "./compile.ts";

const catalogSource = `program published_catalog "Published catalog"
instrument parent {
  title: "Parent";
  summary: "A parent record";
  id_prefix: "par";
  fields { limitAmount: money<SAR>; memo: text; }
  lifecycle { states open closed; initial open; on close: open -> closed; }
  action create { summary: "Create parent"; steps: []; }
  action close { summary: "Close parent"; steps: []; moves: []; }
}
instrument child {
  title: "Child";
  summary: "A child record";
  id_prefix: "chd";
  fields { parentId: text; amount: money<SAR>; }
  lifecycle { states open; initial open; }
  action create { summary: "Create child"; steps: []; }
}`;

function catalog(): UdlDocument {
  const result = compile(catalogSource);
  expect(result.verdict).toBe("valid");
  const document = structuredClone(result.artifacts?.document) as UdlDocument;
  const parent = document.instruments.find(
    (instrument) => instrument.id === "parent",
  )!;
  const child = document.instruments.find(
    (instrument) => instrument.id === "child",
  )!;
  child.fields.parentId = {
    description: "Parent id",
    pattern: "^par_(sandbox|live)_[a-z0-9]{8,64}$",
    type: "string",
  };
  parent.aggregateInvariants = [
    {
      childField: "amount",
      childInstrumentId: "child",
      childRefField: "parentId",
      childStatuses: ["open"],
      parentField: "limitAmount",
    },
  ];
  parent.required = ["memo", "limitAmount"];
  parent.subject = { kinds: ["vehicle"] };
  document.subjects = [
    {
      declaredValue: "optional",
      kind: "vehicle",
      schema: { additionalProperties: false, properties: {}, type: "object" },
      title: "Vehicle",
      version: 1,
    },
  ];
  return document;
}

describe("published program composition", () => {
  it("parses and formats the closed composition declarations", () => {
    const source = `program marketplace "Marketplace"
use parent
expose parent.close as closeMarketplace`;
    const parsed = parseProgram(source);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.program.decls.map((decl) => decl.kind)).toEqual([
      "program",
      "use",
      "expose",
    ]);
    expect(format(source)).toEqual({
      formatted: `program marketplace "Marketplace";
use parent;
expose parent.close as closeMarketplace;
`,
      ok: true,
    });
  });

  it("admits reserved words as published action names", () => {
    const parsed = parseProgram(
      'program marketplace "Marketplace"\nuse parent\nexpose parent.quote as quoteMarketplace',
    );

    expect(parsed.diagnostics).toEqual([]);
  });

  it("copies published instruments with dependency closure and public names", () => {
    const source = `program marketplace "Marketplace"
use parent
expose parent.close as closeMarketplace`;
    const result = compile(source, { publishedCatalog: catalog() });

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument;
    expect(document.instruments.map((instrument) => instrument.id)).toEqual([
      "parent",
      "child",
    ]);
    expect(document.instruments[0]?.actions.close?.publicAction).toBe(
      "closeMarketplace",
    );
    expect(document.instruments[0]?.actions.create).not.toHaveProperty(
      "publicAction",
    );
    expect(document.instruments[0]?.actionOrder).toEqual(["create", "close"]);
    expect(document.instruments[0]?.required).toEqual(["memo", "limitAmount"]);
    expect(document.subjects.map((subject) => subject.kind)).toEqual([
      "vehicle",
    ]);
    expect(serializeUdl(document)).toContain('"childInstrumentId": "child"');

    const useStart = source.indexOf("use parent");
    const exposeStart = source.indexOf("expose parent.close");
    expect(result.artifacts?.originMap).toContainEqual(
      expect.objectContaining({
        path: "$.instruments[0]",
        span: expect.objectContaining({ start: useStart }),
      }),
    );
    expect(result.artifacts?.originMap).toContainEqual(
      expect.objectContaining({
        path: "$.instruments[0].actions.close",
        span: expect.objectContaining({ start: exposeStart }),
      }),
    );
  });

  it("keeps proprietary metadata outside the composed UDL", () => {
    const result = compile(
      `program marketplace "Marketplace"
use parent
const blueprint = { rank: 1; qualityTier: "showcase"; }
expose parent.close as closeMarketplace`,
      { publishedCatalog: catalog() },
    );

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).not.toHaveProperty("blueprint");
  });

  it("merges authored subjects after catalog subjects", () => {
    const result = compile(
      `program marketplace "Marketplace"
use parent
subject shipment {
  title: "Shipment";
  version: 1;
  declared_value: none;
  schema: { type: "object"; properties: {}; additionalProperties: false; };
}`,
      { publishedCatalog: catalog() },
    );

    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("HSX program emitted no artifacts");
    expect(
      (result.artifacts.document as UdlDocument).subjects.map(
        (subject) => subject.kind,
      ),
    ).toEqual(["vehicle", "shipment"]);
  });

  it("rejects an authored subject already supplied by the catalog", () => {
    const result = compile(
      `program marketplace "Marketplace"
use parent
subject vehicle {
  title: "Vehicle";
  version: 1;
  declared_value: optional;
  schema: { type: "object"; properties: {}; additionalProperties: false; };
}`,
      { publishedCatalog: catalog() },
    );

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1008" }),
    );
  });

  it("requires a catalog when a program uses published composition forms", () => {
    const result = compile(
      'program marketplace "Marketplace"\nuse parent\nexpose parent.close as closeMarketplace',
    );

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1018" }),
    );
  });

  it.each([
    {
      code: "HSX1015",
      source: "program marketplace\nuse parent",
    },
    {
      code: "HSX1016",
      source: 'program marketplace "Marketplace"',
    },
    {
      code: "HSX1017",
      source: 'program marketplace "Marketplace"\nuse parent\nuse parent',
    },
    {
      code: "HSX1018",
      source: 'program marketplace "Marketplace"\nuse missing',
    },
    {
      code: "HSX1020",
      source:
        'program marketplace "Marketplace"\nuse parent\nexpose parent.close as NotCamel',
    },
    {
      code: "HSX1020",
      source:
        'program marketplace "Marketplace"\nuse parent\nexpose parent.create as closeMarketplace\nexpose parent.close as closeMarketplace',
    },
    {
      code: "HSX1021",
      source:
        'program marketplace "Marketplace"\nuse parent\nexpose parent.missing as closeMarketplace',
    },
    {
      code: "HSX1022",
      source: `program marketplace "Marketplace"
use parent
instrument local { fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }`,
    },
  ])("reports $code for an invalid composed program", ({ code, source }) => {
    const result = compile(source, { publishedCatalog: catalog() });

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code }),
    );
  });

  it("does not limit how many published instruments a program uses", () => {
    const source = `program published_catalog "Published catalog"
${Array.from(
  { length: 10 },
  (_, index) => `instrument item_${index} {
  id_prefix: "i${String.fromCharCode(97 + index)}x";
  fields {}
  lifecycle { states open; initial open; }
  action create { steps: []; }
}`,
).join("\n")}`;
    const catalogResult = compile(source);
    expect(catalogResult.verdict).toBe("valid");
    const publishedCatalog = catalogResult.artifacts?.document as
      | UdlDocument
      | undefined;
    if (!publishedCatalog) throw new Error("expected compiled catalog");

    const result = compile(
      `program marketplace "Marketplace"
${Array.from({ length: 10 }, (_, index) => `use item_${index}`).join("\n")}`,
      { publishedCatalog },
    );

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document.instruments).toHaveLength(10);
  });

  it("refuses JSON at the parse boundary", () => {
    const result = compile('{ "hsx": 1, "product": "marketplace" }', {
      publishedCatalog: catalog(),
    });

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1014",
        message: "JSON is not HSX",
        stage: "parse",
      }),
    );
  });
});
