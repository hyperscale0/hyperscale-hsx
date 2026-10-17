/**
 * Pack-time entry-point rewrite (prepack applies, postpack restores). The
 * workspace keeps entry points on src/ so tests never read a stale dist/; the
 * tarball points at dist/ because Node cannot import .ts from node_modules.
 * Each ./src/X.ts entry in package.json maps to ./dist/src/X.js and its .d.ts,
 * and back; data entries such as ./package.json stay as they are.
 */
const packageJsonPath = new URL("../package.json", import.meta.url);
const dist = "./dist/src/";
const fields = ["main", "module", "types"] as const;

const mode = process.argv[2];
if (mode !== "apply" && mode !== "restore") {
  throw new Error("usage: pack-exports.ts <apply|restore>");
}

const manifest = JSON.parse(await Bun.file(packageJsonPath).text()) as Record<
  (typeof fields)[number],
  string
> & { exports: Record<string, string | { types: string; default: string }> };
if (mode === "apply") {
  const built = (path: string, extension: string) =>
    path.replace(/^\.\/src\/(.+)\.ts$/, `${dist}$1${extension}`);
  for (const field of fields)
    manifest[field] = built(
      manifest[field],
      field === "types" ? ".d.ts" : ".js",
    );
  for (const [key, path] of Object.entries(manifest.exports))
    if (typeof path === "string" && built(path, ".js") !== path)
      manifest.exports[key] = {
        types: built(path, ".d.ts"),
        default: built(path, ".js"),
      };
} else {
  const source = (path: string) =>
    path.startsWith(dist)
      ? `./src/${path.slice(dist.length).replace(/\.(?:d\.ts|js)$/, "")}.ts`
      : path;
  for (const field of fields) manifest[field] = source(manifest[field]);
  for (const [key, path] of Object.entries(manifest.exports))
    if (typeof path !== "string") manifest.exports[key] = source(path.default);
}
await Bun.write(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
