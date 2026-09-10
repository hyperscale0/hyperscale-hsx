# HSX for VS Code

This extension adds syntax highlighting, standard-library snippets, language
server diagnostics, and formatting for `.hsx` files.

The language client runs `hsx lsp` over stdio. Install the compiler binary
globally:

```sh
npm i -g @hyperscale0/hsx
```

## Settings

- `hsx.serverPath`: Path to the `hsx` executable. Defaults to `hsx`. The extension reads this setting at activation, and a window reload applies a change.

## Build

Typecheck the source with strict tsc, then build the bundle to `dist/extension.js`:

```sh
bun run typecheck
bun run build
```

## Install the extension

Download the package from https://hyperscale0.ai/downloads/hsx-vscode.vsix, then run:

```sh
code --install-extension hsx-vscode.vsix
```

You can also install via the Extensions view in VS Code or Cursor: open the
Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`), select the **...** menu,
choose **Install from VSIX...**, and select the downloaded file. The same
`.vsix` package works in Cursor and other VS Code forks.

To package the extension from this directory:

```sh
bun run package
```
