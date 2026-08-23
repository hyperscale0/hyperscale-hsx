/**
 * Pack-time entry-point rewrite (prepack applies, postpack restores).
 *
 * The workspace package.json keeps main/module/types/exports on a `.ts`
 * source: a dist-pointing mapping visible to the workspace would let a
 * consumer read the untracked (and possibly stale) dist/ build during
 * `vp test`. The published tarball needs the opposite, because native Node
 * cannot import .ts out of node_modules. That is the split pnpm formalizes as
 * publishConfig field overrides; npm has no equivalent, hence the two hooks.
 *
 * Both modes write the same field set, so `restore` puts the manifest back
 * whether or not `apply` ran.
 *
 * The rewrite reaches those four fields because a consumer reads them from the
 * package.json INSIDE the installed tarball. It cannot reach `bin`: npm links
 * node_modules/.bin from the registry packument, and publish.js re-reads
 * package.json from disk AFTER postpack has already restored it. 1.0.0-alpha.1
 * shipped that way, so every install got a .bin/hsx pointing at bin/hsx.ts and
 * Node refused to execute it. `bin` stays dist-pointing at rest and is absent
 * from both entry sets below; scripts/check-bin.ts holds it there.
 */
const packageJsonPath = new URL("../package.json", import.meta.url);

const dataExports = {
  "./spec/hsx-ir.schema.json": "./spec/hsx-ir.schema.json",
  "./package.json": "./package.json",
};

const sourceEntries = {
  main: "./src/index.ts",
  module: "./src/index.ts",
  types: "./src/index.ts",
  exports: { ".": "./src/index.ts", ...dataExports },
};

const distEntries = {
  main: "./dist/src/index.js",
  module: "./dist/src/index.js",
  types: "./dist/src/index.d.ts",
  exports: {
    ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" },
    ...dataExports,
  },
};

const mode = process.argv[2];
if (mode !== "apply" && mode !== "restore") {
  throw new Error("usage: pack-exports.ts <apply|restore>");
}

const manifest = JSON.parse(await Bun.file(packageJsonPath).text()) as Record<
  string,
  unknown
>;
Object.assign(manifest, mode === "apply" ? distEntries : sourceEntries);
await Bun.write(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
