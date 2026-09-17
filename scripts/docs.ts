import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { headerManifest } from "../src/headers.ts";
const root = new URL("../", import.meta.url);
const manifest = headerManifest({
  source: (header) => readFileSync(new URL(`std/${header}.hsx`, root), "utf8"),
});
const rows = [
  "# Header inventory",
  "",
  "Each company selects library policies through typed tunables.",
  "`ref<T>[]` accepts one reference or up to 16 references as one policy. `approval` accepts a party and generates the required decision records.",
  "",
  "| Object | Tunables |",
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
const reference = await readFile(new URL("docs/README.md", root), "utf8");
await writeFile(
  new URL("llms.txt", root),
  "# HSX 3\n\n- [Language](docs/README.md)\n- [Headers](docs/headers.md)\n- [Example](examples/library.hsx)\n",
);
await writeFile(new URL("llms-full.txt", root), reference + "\n" + inventory);
