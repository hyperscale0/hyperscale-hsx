import { readFile } from "node:fs/promises";
import { compile } from "../src/compile.ts";
import { serializeUdl } from "@hyperscale0/udl";

/** The executable inventory exercises every public header object. */
export async function compileCatalogue() {
  const source = await readFile(
    new URL("../examples/library.hsx", import.meta.url),
    "utf8",
  );
  const result = compile(source);
  if (!result.artifacts || result.diagnostics.length)
    throw new Error(
      result.diagnostics
        .map((d) => `${d.line}:${d.column}: ${d.message}`)
        .join("\n"),
    );
  return result.artifacts.document;
}
if (import.meta.main)
  process.stdout.write(serializeUdl(await compileCatalogue()));
