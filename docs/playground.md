# Browser playground

The HSX playground is a static browser application for authoring, editing,
and inspecting HSX programs without a server. It runs the compiler directly
in the browser client.

## What it provides

- Source editor with line numbers and debounced compilation (200 ms).
- Verdict badge showing `valid`, `warning`, or `invalid`.
- Diagnostics panel with stage, code, line and column coordinates, message,
  and suggested fix. Clicking any diagnostic focuses the editor and highlights
  the exact source span.
- Tabbed output pane showing the lowered canonical UDL document as formatted
  JSON and the UDL cost manifest.
- Built-in example selector containing the full corpus of test programs and
  standard-library settlements.
- Pure client execution with no Node runtime dependencies.

## Build the playground

Generate the examples manifest, bundle the browser assets, and copy static
files to `open/hsx/playground/dist/`:

```bash
bun run --cwd open/hsx playground:build
```

Verify that the generated static bundle contains no Node specifiers or URL
resolution calls:

```bash
bun run --cwd open/hsx playground:check
```

## Serve locally

The deliverable is the static directory under `open/hsx/playground/dist/`.
Hosting infrastructure is owner-owed. To run the playground locally, serve
the output directory with any local static file server.

Using Bun:

```bash
bunx serve open/hsx/playground/dist
```

Using Python:

```bash
python3 -m http.server -d open/hsx/playground/dist 8000
```

Open `http://localhost:8000` in a browser.
