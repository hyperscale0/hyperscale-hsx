import { compile } from "../src/index.ts";
const source = document.querySelector<HTMLTextAreaElement>("#source")!;
const status = document.querySelector<HTMLElement>("#status")!;
const output = document.querySelector<HTMLElement>("#output")!;
source.value = `program tip_jar "Tip jar"
use money
party listener: person
party host: business
tip = money.transfer { payer: listener, payee: host, amount: 10 SAR }
`;
function render() {
  const result = compile(source.value);
  status.textContent =
    result.verdict === "valid"
      ? "Valid UDL 3"
      : "Correct the diagnostics below";
  output.textContent = result.artifacts
    ? JSON.stringify(result.artifacts.document, null, 2)
    : result.diagnostics
        .map((d) => `${d.line}:${d.column} ${d.message}. ${d.fix}`)
        .join("\n");
}
document.querySelector("#compile")!.addEventListener("click", render);
render();
