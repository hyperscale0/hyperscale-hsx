import { compile } from "../src/index.ts";
import { highlight, describe } from "@hyperscale0/hsx/language";
const source = document.querySelector<HTMLTextAreaElement>("#source")!;
const status = document.querySelector<HTMLElement>("#status")!;
const output = document.querySelector<HTMLElement>("#output")!;
const tokens = document.querySelector<HTMLElement>("#tokens")!;
const explanation = document.querySelector<HTMLElement>("#explanation")!;
source.value = `program tips "Tips"
use money
object tip "Tips" {
  fields { message: text }
  attach payment = money.transfer {
    payer: actor, payee: owner, amount: 10 SAR
    expose create as create_tip
    expose pay as give
  }
}
`;
function explain(offset: number) {
  const hover = describe(source.value, offset);
  explanation.textContent = hover
    ? [
        hover.title,
        hover.signature,
        hover.summary,
        ...(hover.details?.map((d) => `${d.label}: ${d.value}`) ?? []),
      ]
        .filter(Boolean)
        .join("\n")
    : "Point at a name or keyword, or move the cursor in the editor, to read its explanation.";
}
function color() {
  const fragment = document.createDocumentFragment();
  let end = 0;
  for (const token of highlight(source.value)) {
    fragment.append(source.value.slice(end, token.start));
    const span = document.createElement("span");
    span.className = `hsx-${token.class}`;
    span.dataset.offset = String(token.start);
    span.textContent = source.value.slice(token.start, token.end);
    fragment.append(span);
    end = token.end;
  }
  fragment.append(source.value.slice(end));
  tokens.replaceChildren(fragment);
  explain(source.selectionStart);
}
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
tokens.addEventListener("pointerover", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.offset !== undefined)
    explain(Number(target.dataset.offset));
});
source.addEventListener("input", color);
source.addEventListener("click", () => explain(source.selectionStart));
source.addEventListener("keyup", () => explain(source.selectionStart));
document.querySelector("#compile")!.addEventListener("click", render);
color();
render();
