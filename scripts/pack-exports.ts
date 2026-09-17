/** Publish JavaScript entry points while source checkouts resolve TypeScript. */
const packageJsonPath = new URL("../package.json", import.meta.url);

const dataExports = {
  "./package.json": "./package.json",
  "./std/*": "./std/*",
};

const sourceEntries = {
  main: "./src/index.ts",
  module: "./src/index.ts",
  types: "./src/index.ts",
  exports: {
    ".": "./src/index.ts",
    "./cost": "./src/cost.ts",
    ...dataExports,
  },
};

const distEntries = {
  main: "./dist/src/index.js",
  module: "./dist/src/index.js",
  types: "./dist/src/index.d.ts",
  exports: {
    ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" },
    "./cost": {
      types: "./dist/src/cost.d.ts",
      default: "./dist/src/cost.js",
    },
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
