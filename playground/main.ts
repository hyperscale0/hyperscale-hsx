import {
  byteOffsetToCodeUnit,
  compile,
  type CompileDiagnostic,
  type CompileResult,
} from "../src/index.ts";
import { PLAYGROUND_EXAMPLES } from "./examples.ts";

const sourceEditor = document.getElementById(
  "source-editor",
) as HTMLTextAreaElement;
const lineGutter = document.getElementById("line-gutter") as HTMLElement;
const verdictBadge = document.getElementById("verdict-badge") as HTMLElement;
const examplesSelect = document.getElementById(
  "examples-select",
) as HTMLSelectElement;
const udlOutput = document.getElementById("udl-output") as HTMLElement;
const costOutput = document.getElementById("cost-output") as HTMLElement;
const tabUdlBtn = document.getElementById("tab-udl-btn") as HTMLButtonElement;
const tabCostBtn = document.getElementById("tab-cost-btn") as HTMLButtonElement;
const tabUdlContent = document.getElementById("tab-udl-content") as HTMLElement;
const tabCostContent = document.getElementById(
  "tab-cost-content",
) as HTMLElement;
const diagnosticsCount = document.getElementById(
  "diagnostics-count",
) as HTMLElement;
const diagnosticsList = document.getElementById(
  "diagnostics-list",
) as HTMLElement;

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function updateGutter(): void {
  const lines = sourceEditor.value.split("\n").length;
  const numbers: string[] = [];
  for (let i = 1; i <= lines; i++) {
    numbers.push(String(i));
  }
  lineGutter.textContent = numbers.join("\n");
}

function renderDiagnostics(diagnostics: readonly CompileDiagnostic[]): void {
  diagnosticsList.innerHTML = "";

  if (diagnostics.length === 0) {
    diagnosticsCount.textContent = "0 issues";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "diagnostic-empty";
    td.textContent = "No diagnostics. Compilation passed cleanly.";
    tr.appendChild(td);
    diagnosticsList.appendChild(tr);
    return;
  }

  diagnosticsCount.textContent = `${diagnostics.length} ${diagnostics.length === 1 ? "issue" : "issues"}`;

  for (const diagnostic of diagnostics) {
    const tr = document.createElement("tr");
    tr.className = `diagnostic-row severity-${diagnostic.severity}`;
    tr.tabIndex = 0;

    const tdStage = document.createElement("td");
    tdStage.className = "col-stage";
    tdStage.textContent = diagnostic.stage;

    const tdCode = document.createElement("td");
    tdCode.className = "col-code";
    tdCode.textContent = diagnostic.code ?? "-";

    const tdPos = document.createElement("td");
    tdPos.className = "col-pos";
    tdPos.textContent = `${diagnostic.line}:${diagnostic.column}`;

    const tdMessage = document.createElement("td");
    tdMessage.className = "col-message";
    tdMessage.textContent = diagnostic.message;

    const tdFix = document.createElement("td");
    tdFix.className = "col-fix";
    tdFix.textContent = diagnostic.fix ?? "-";

    tr.appendChild(tdStage);
    tr.appendChild(tdCode);
    tr.appendChild(tdPos);
    tr.appendChild(tdMessage);
    tr.appendChild(tdFix);

    const selectSpan = (): void => {
      sourceEditor.focus();
      const start = byteOffsetToCodeUnit(
        sourceEditor.value,
        diagnostic.span.start,
      );
      const end = byteOffsetToCodeUnit(sourceEditor.value, diagnostic.span.end);
      sourceEditor.setSelectionRange(start, end);
    };

    tr.addEventListener("click", selectSpan);
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSpan();
      }
    });

    diagnosticsList.appendChild(tr);
  }
}

function runCompile(): void {
  const source = sourceEditor.value;
  const result: CompileResult = compile(source);

  verdictBadge.textContent = result.verdict;
  verdictBadge.className = `badge badge-${result.verdict}`;

  if (result.artifacts) {
    udlOutput.textContent = JSON.stringify(result.artifacts.document, null, 2);
    costOutput.textContent = JSON.stringify(
      result.artifacts.costManifest,
      null,
      2,
    );
  } else {
    udlOutput.textContent = "No canonical UDL document produced.";
    costOutput.textContent = "No cost manifest produced.";
  }

  renderDiagnostics(result.diagnostics);
}

function scheduleCompile(): void {
  updateGutter();
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    runCompile();
  }, 200);
}

sourceEditor.addEventListener("input", scheduleCompile);
sourceEditor.addEventListener("scroll", () => {
  lineGutter.scrollTop = sourceEditor.scrollTop;
});

tabUdlBtn.addEventListener("click", () => {
  tabUdlBtn.classList.add("active");
  tabCostBtn.classList.remove("active");
  tabUdlContent.classList.add("active");
  tabCostContent.classList.remove("active");
});

tabCostBtn.addEventListener("click", () => {
  tabCostBtn.classList.add("active");
  tabUdlBtn.classList.remove("active");
  tabCostContent.classList.add("active");
  tabUdlContent.classList.remove("active");
});

function initExamples(): void {
  for (const example of PLAYGROUND_EXAMPLES) {
    const option = document.createElement("option");
    option.value = example.name;
    option.textContent = example.name;
    examplesSelect.appendChild(option);
  }

  examplesSelect.addEventListener("change", () => {
    const chosen = PLAYGROUND_EXAMPLES.find(
      (ex) => ex.name === examplesSelect.value,
    );
    if (chosen) {
      sourceEditor.value = chosen.source;
      updateGutter();
      runCompile();
    }
  });

  if (PLAYGROUND_EXAMPLES.length > 0) {
    const initial =
      PLAYGROUND_EXAMPLES.find((ex) => ex.name.includes("tip-jar")) ??
      PLAYGROUND_EXAMPLES[0]!;
    examplesSelect.value = initial.name;
    sourceEditor.value = initial.source;
    updateGutter();
    runCompile();
  } else {
    updateGutter();
  }
}

initExamples();
