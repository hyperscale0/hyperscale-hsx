import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { serializeUdl } from "@hyperscale0/udl";
import { afterAll, describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";
import { archetypeUdlBaseline } from "./archetype-baseline.ts";
import {
  archetypeWitnessCases,
  stdSettlementModules,
} from "./archetype-witness-cases.ts";

const packageRoot = join(import.meta.dir, "..");
const settlementsRoot = join(import.meta.dir, "..", "std", "settlements");
const oracleRoot = join(import.meta.dir, "fixtures", "general-path-oracle");
const costManifestRoot = join(import.meta.dir, "fixtures", "cost-manifests");
const baselineByPath: Readonly<Record<string, string>> = archetypeUdlBaseline;
let exactPrograms = 0;

function oracleName(relativePath: string): string {
  return `${relativePath.replace(/\.hsx$/, "").replaceAll("/", "__")}.udl`;
}

describe("general-path archetype witness", () => {
  afterAll(() => {
    console.log(`${exactPrograms}/34 canonical UDL documents byte-exact`);
  });

  test("the witness pins every standard module and 34 package cases", () => {
    const moduleFiles = readdirSync(settlementsRoot)
      .filter((name) => name !== "index.hsx" && name.endsWith(".hsx"))
      .map((name) => name.slice(0, -4))
      .sort();
    const witnessPaths = Object.keys(archetypeWitnessCases).sort();
    const baselinePaths = Object.keys(archetypeUdlBaseline).sort();
    const oracleFiles = readdirSync(oracleRoot).sort();
    const costManifestFiles = readdirSync(costManifestRoot).sort();
    const witnessedModules = [
      ...new Set(
        Object.values(archetypeWitnessCases).flatMap(
          (witnessCase) => witnessCase.modules,
        ),
      ),
    ].sort();

    expect(moduleFiles).toEqual([...stdSettlementModules].sort());
    expect(witnessedModules).toEqual([...stdSettlementModules].sort());
    expect(witnessPaths).toHaveLength(34);
    expect(witnessPaths).toEqual(baselinePaths);
    expect(oracleFiles).toEqual(witnessPaths.map(oracleName).sort());
    expect(costManifestFiles).toEqual(
      witnessPaths
        .map((path) => oracleName(path).replace(/\.udl$/, ".json"))
        .sort(),
    );
  });

  for (const moduleName of stdSettlementModules) {
    test(`std/settlements/${moduleName} owns an exported general instrument`, () => {
      const source = readFileSync(
        join(settlementsRoot, `${moduleName}.hsx`),
        "utf8",
      );

      expect(source).toContain(`module std.settlements.${moduleName}`);
      expect(source).toContain(`export instrument ${moduleName}`);
    });
  }

  test("all 34 canonical oracle outputs contain no compiler sentinel", () => {
    const oracleFiles = readdirSync(oracleRoot).sort();
    expect(oracleFiles).toHaveLength(34);
    for (const file of oracleFiles) {
      const bytes = readFileSync(join(oracleRoot, file), "utf8");
      expect(bytes).not.toContain("__hsx_none__");
      expect(bytes).not.toContain("invalid_compile_time_name");
    }
  });

  for (const [relativePath, witnessCase] of Object.entries(
    archetypeWitnessCases,
  )) {
    test(`${relativePath} emits its pinned canonical UDL`, () => {
      const source = readFileSync(join(packageRoot, relativePath), "utf8");
      for (const moduleName of witnessCase.modules) {
        expect(source).toContain(moduleName);
      }

      const result = compile(source, {
        moduleName: relativePath,
      });
      if (!result.artifacts) {
        const failures = result.diagnostics
          .map(
            (diagnostic) =>
              `${diagnostic.stage} ${diagnostic.code ?? "uncoded"} ${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`,
          )
          .join("\n");
        throw new Error(
          `${relativePath} did not compile through the general path\n${failures}`,
        );
      }

      const document = result.artifacts.document;
      if (document.udl !== 1) {
        throw new Error(
          `${relativePath} returned legacy HSX IR instead of a direct UDL document`,
        );
      }

      const expectedDigest = baselineByPath[relativePath];
      if (!expectedDigest) {
        throw new Error(`${relativePath} has no pinned canonical UDL digest`);
      }
      const actualBytes = serializeUdl(document);
      const expectedBytes = readFileSync(
        join(oracleRoot, oracleName(relativePath)),
        "utf8",
      );
      expect(actualBytes).toBe(expectedBytes);
      expect(result.artifacts.costManifest).toEqual(
        JSON.parse(
          readFileSync(
            join(
              costManifestRoot,
              oracleName(relativePath).replace(/\.udl$/, ".json"),
            ),
            "utf8",
          ),
        ),
      );
      const actualDigest = createHash("sha256")
        .update(actualBytes)
        .digest("hex");

      expect(actualDigest).toBe(expectedDigest);
      exactPrograms += 1;
    });
  }
});
