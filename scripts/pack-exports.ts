/**
 * Pack-time entry-point rewrite (prepack applies, postpack restores).
 *
 * The workspace package.json must keep every entry point on a `.ts` source: a
 * dist-pointing mapping visible to the workspace would let a consumer read the
 * untracked (and possibly stale) dist/ build during `vp test`. The published
 * tarball needs the opposite, because native Node cannot import .ts out of
 * node_modules. That is the split pnpm formalizes as publishConfig field
 * overrides; npm has no equivalent, hence the two hooks.
 *
 * Both modes write the same field set, so `restore` puts the manifest back
 * whether or not `apply` ran.
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
  bin: { hsx: "./bin/hsx.ts" },
  exports: { ".": "./src/index.ts", ...dataExports },
};

const distEntries = {
  main: "./dist/src/index.js",
  module: "./dist/src/index.js",
  types: "./dist/src/index.d.ts",
  // Native Node cannot run a .ts bin out of node_modules either.
  bin: { hsx: "./dist/bin/hsx.js" },
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
