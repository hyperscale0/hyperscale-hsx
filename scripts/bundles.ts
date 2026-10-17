// Writes the three gitignored bundles in src/ from the authored std headers,
// examples and bases. With --check it writes nothing and fails when a bundle
// on disk differs from what its authored files make, so a stale bundle never
// reaches a typecheck, a test or a build.
//
//   bun scripts/bundles.ts [--check]
//
// The examples and bases scripts import the compiler, which imports the std
// bundle, so each script loads only after the bundle before it is written.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const bundles = [
  [
    "src/std-bundle.ts",
    "std/*.hsx",
    async () => (await import("./bundle-std.ts")).generateStdBundleCode(),
  ],
  [
    "src/examples-bundle.ts",
    "examples/*.hsx",
    async () =>
      (await import("./bundle-examples.ts")).generateExamplesBundleCode(),
  ],
  [
    "src/bases-bundle.ts",
    "bases/*.hsx",
    async () => (await import("./bundle-bases.ts")).generateBasesBundleCode(),
  ],
] as const;

const check = process.argv.includes("--check");
const stale: string[] = [];
for (const [target, sources, generate] of bundles) {
  const url = new URL(`../${target}`, import.meta.url);
  if (check && !existsSync(url)) {
    stale.push(`open/hsx/${target} is missing`);
    break;
  }
  const code = await generate();
  if (!check) writeFileSync(url, code, "utf8");
  else if (readFileSync(url, "utf8") !== code)
    stale.push(`open/hsx/${target} is stale against open/hsx/${sources}`);
}
if (stale.length) {
  process.stderr.write(
    `${stale.join("\n")}\nRun bun run generated:write, or bun run generate in open/hsx.\n`,
  );
  process.exitCode = 1;
} else
  process.stdout.write(
    `${check ? "Checked" : "Wrote"} ${bundles.length} HSX bundles.\n`,
  );
