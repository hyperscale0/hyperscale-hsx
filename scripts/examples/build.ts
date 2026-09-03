import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeUdl } from "@hyperscale0/udl";
import costTable from "../../examples/cost-table.json";
import { compile } from "../../src/compile.ts";
import type { UdlCostTable } from "../../src/cost.ts";

const packageRoot = join(import.meta.dir, "../..");
const skillPath = join(packageRoot, "skills", "hsx", "SKILL.md");
const examplesRoot = join(packageRoot, "examples");
const marker = /^<!--\s*hsx-brick:\s*([a-z_]+)\s*-->$/;

function witnesses(): ReadonlyMap<string, string> {
  const lines = readFileSync(skillPath, "utf8").split("\n");
  const found = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const name = marker.exec(lines[index]?.trim() ?? "")?.[1];
    if (!name) continue;
    const opening = lines.indexOf("```hsx", index + 1);
    const closing = lines.indexOf("```", opening + 1);
    if (opening < 0 || closing < 0)
      throw new Error(`${name} has no HSX witness`);
    found.set(name, lines.slice(opening + 1, closing).join("\n"));
  }
  return found;
}

const programs = witnesses();
const modules = readdirSync(join(packageRoot, "std", "settlements"))
  .filter((file) => file.endsWith(".hsx") && file !== "index.hsx")
  .map((file) => file.slice(0, -4))
  .sort();

if ([...programs.keys()].sort().join("\n") !== modules.join("\n")) {
  throw new Error("the skill witness set does not match std/settlements");
}

for (const name of modules) {
  const source = programs.get(name);
  if (!source) throw new Error(`${name} has no witness`);
  const result = compile(source, {
    costTable: costTable as UdlCostTable,
    moduleName: `examples/${name}/${name}.hsx`,
  });
  if (!result.artifacts || result.verdict !== "valid") {
    throw new Error(`${name} failed: ${JSON.stringify(result.diagnostics)}`);
  }
  const directory = join(examplesRoot, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.hsx`), `${source.trim()}\n`);
  writeFileSync(
    join(directory, "README.md"),
    `# ${name}\n\nThis example applies the \`${name}\` standard-library module. Its sibling UDL file pins the canonical compiler output byte for byte. The company and parties are invented.\n`,
  );
  writeFileSync(
    join(directory, `${name}.udl`),
    serializeUdl(result.artifacts.document),
  );
}

console.log(`wrote ${modules.length} standard-library examples`);
