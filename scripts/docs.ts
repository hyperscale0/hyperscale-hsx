import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { readExamples } from "./bundle-examples.ts";
import { headerManifest } from "../src/headers.ts";
const root = new URL("../", import.meta.url);
const manifest = headerManifest({
  source: (header) => readFileSync(new URL(`std/${header}.hsx`, root), "utf8"),
});
const rows = [
  "# Header inventory",
  "",
  "Attach library instruments inside authored object kinds. Each program selects policies through typed tunables.",
  "Bind party parameters to owner, actor, operator or declared parties. Configure declared businesses per Build. The authoringTemplate source is an attach fragment for an object block. An attachment may expose create by name; clock and parent actions remain internal.",
  "`ref<T>[]` accepts one reference or up to 16 references as one policy.",
  "",
  "| Instrument | Tunables |",
  "| --- | --- |",
];
for (const header of manifest.headers)
  for (const object of header.objects) {
    const tunables = object.tunables.map(
      (t) =>
        `${t.name}: ${t.type}${t.default === undefined ? "" : ` = ${t.default}`}`,
    );
    rows.push(
      `| ${object.qualifiedName} | ${tunables.map((t) => "`" + t + "`").join(", ")}${object.constraints.length ? "; " + object.constraints.map((constraint) => `${constraint.tunable} ${constraint.relation} ${constraint.other}`).join(", ") : ""} |`,
    );
  }
await mkdir(new URL("docs/", root), { recursive: true });
const inventory = rows.join("\n") + "\n";
await writeFile(new URL("docs/headers.md", root), inventory);
const examples = readExamples();
const examplesReference = [
  "# Sample programs",
  "",
  "Each file is an authored program. Object creation enters no agreement; an attachment may expose its instrument create action by name. Compilation alone does not prove a complete business flow.",
  "",
  "| Program | Headers | Business |",
  "| --- | --- | --- |",
  ...examples.map(
    (example) =>
      `| [${example.title}](../examples/${example.id}.hsx) | ${example.headers.join(", ")} | ${example.summary} |`,
  ),
  "",
].join("\n");
await writeFile(new URL("docs/examples.md", root), examplesReference);
const reference = await readFile(new URL("docs/README.md", root), "utf8");
// The combined document lives at the package root, one level above docs/.
const rootReference = reference
  .replaceAll("](../", "](")
  .replaceAll("](headers.md)", "](docs/headers.md)")
  .replaceAll("](examples.md)", "](docs/examples.md)");
await writeFile(
  new URL("llms.txt", root),
  "# HSX\n\n- [Language](docs/README.md)\n- [Headers](docs/headers.md)\n- [Samples](docs/examples.md)\n",
);
await writeFile(
  new URL("llms-full.txt", root),
  rootReference +
    "\n" +
    inventory +
    "\n" +
    examplesReference.replaceAll("](../examples/", "](examples/"),
);
