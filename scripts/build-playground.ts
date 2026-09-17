const result = await Bun.build({
  entrypoints: [new URL("../playground/main.ts", import.meta.url).pathname],
  outdir: new URL("../playground/", import.meta.url).pathname,
  naming: "bundle.js",
  target: "browser",
  minify: true,
});
if (!result.success)
  throw new AggregateError(result.logs, "playground build failed");
