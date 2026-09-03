import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("hsx");
  const command = config.get<string>("serverPath", "hsx");

  const serverOptions: ServerOptions = {
    args: ["lsp"],
    command,
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "hsx", scheme: "file" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.hsx"),
    },
  };

  client = new LanguageClient(
    "hsx",
    "HSX Language Server",
    serverOptions,
    clientOptions,
  );
  context.subscriptions.push(client);
  void client.start();
}

export function deactivate(): Promise<void> | undefined {
  if (!client) return undefined;
  return client.stop();
}
