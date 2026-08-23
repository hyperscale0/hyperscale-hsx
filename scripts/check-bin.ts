/**
 * Post-build `bin` assertion. Run after `bun run build`.
 *
 * Every published `bin` target must be executable by native Node straight out
 * of node_modules. npm links node_modules/.bin from these paths as they appear
 * in the registry packument, and the packument is built from THIS file on disk:
 * publish.js re-reads it after postpack, so a prepack rewrite never reaches it. 1.0.0-alpha.1 published `bin` pointing at TypeScript and every install
 * got a link Node refused to run. These three assertions pin that shut.
 */
import { readFile } from "node:fs/promises";

const SHEBANG = "#!/usr/bin/env node";
const packageRoot = new URL("..", import.meta.url);

const manifest = JSON.parse(
  await readFile(new URL("package.json", packageRoot), "utf8"),
) as { readonly bin?: Readonly<Record<string, string>> };

const entries = Object.entries(manifest.bin ?? {});
if (entries.length === 0) {
  throw new Error("check-bin: package.json declares no bin");
}

const failures: string[] = [];
for (const [name, target] of entries) {
  if (!target.endsWith(".js")) {
    failures.push(
      `${name}: ${target} is not .js, and Node cannot execute TypeScript out of node_modules`,
    );
    continue;
  }

  let firstLine: string;
  try {
    const contents = await readFile(new URL(target, packageRoot), "utf8");
    firstLine = contents.split("\n", 1)[0] ?? "";
  } catch {
    failures.push(`${name}: ${target} does not exist after build`);
    continue;
  }

  if (firstLine !== SHEBANG) {
    failures.push(
      `${name}: ${target} starts with ${JSON.stringify(firstLine)}, expected ${JSON.stringify(SHEBANG)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`check-bin: ${failures.length} failing bin target(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `check-bin: ${entries.length} bin target(s) built, .js, and node-executable`,
);
