import { compile } from "../src/index.ts";
const source = document.querySelector<HTMLTextAreaElement>("#source")!;
const status = document.querySelector<HTMLElement>("#status")!;
const output = document.querySelector<HTMLElement>("#output")!;
source.value = `program tips "Tips"
use money
object tip "Tips" {
  fields { message: text }
  attach payment = money.transfer {
    payer: actor, payee: owner, amount: 10 SAR
    expose pay as give
  }
}
`;
function render() {
  const result = compile(source.value);
  status.textContent =
    result.verdict === "valid"
      ? "Valid UDL 4"
      : "Correct the diagnostics below";
  output.textContent = result.artifacts
    ? JSON.stringify(result.artifacts.document, null, 2)
    : result.diagnostics
        .map((d) => `${d.line}:${d.column} ${d.message}. ${d.fix}`)
        .join("\n");
}
document.querySelector("#compile")!.addEventListener("click", render);
render();
