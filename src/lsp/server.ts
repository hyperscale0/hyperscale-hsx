import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lineIndex, type LineIndex } from "../ast.ts";
import { format } from "../format.ts";
import type { HsxCompilerHost, ModuleSource } from "../modules.ts";
import { resolveProgramModules } from "../modules.ts";
import { parseProgram } from "../parse.ts";
import { checkGeneralProgram } from "../typecheck.ts";

export interface LspPosition {
  readonly character: number;
  readonly line: number;
}

export interface LspRange {
  readonly end: LspPosition;
  readonly start: LspPosition;
}

export interface LspDiagnostic {
  readonly code?: string;
  readonly message: string;
  readonly range: LspRange;
  readonly severity: 1 | 2;
  readonly source: "hsx";
}

export interface LspServerOptions {
  readonly host?: HsxCompilerHost;
  readonly onExit?: (code: number) => void;
}

export interface LspServer {
  readonly stop: () => void;
}

export function offsetToPosition(
  index: LineIndex,
  offset: number,
): LspPosition {
  const clamped = Math.max(0, Math.min(offset, index.length));
  let low = 0;
  let high = index.starts.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if ((index.starts[middle] as number) <= clamped) low = middle;
    else high = middle - 1;
  }
  const lineStart = index.starts[low] as number;
  return {
    character: clamped - lineStart,
    line: low,
  };
}

export function spanToRange(
  index: LineIndex,
  span: { readonly end: number; readonly start: number },
): LspRange {
  return {
    end: offsetToPosition(index, Math.max(span.start, span.end)),
    start: offsetToPosition(index, span.start),
  };
}

export function createHostForUri(
  uri: string,
  fallbackHost?: HsxCompilerHost,
): HsxCompilerHost {
  let docDir: string | undefined;
  try {
    if (uri.startsWith("file://")) {
      docDir = dirname(fileURLToPath(uri));
    }
  } catch {
    docDir = undefined;
  }

  return {
    resolveModule(specifier: string, from: string): ModuleSource | undefined {
      if (fallbackHost?.resolveModule) {
        const custom = fallbackHost.resolveModule(specifier, from);
        if (custom) return custom;
      }
      if (!docDir) return undefined;
      const baseDir = from
        ? isAbsolute(from)
          ? dirname(from)
          : resolve(docDir, dirname(from))
        : docDir;
      const candidates = [
        resolve(baseDir, specifier),
        resolve(baseDir, `${specifier}.hsx`),
        resolve(docDir, specifier),
        resolve(docDir, `${specifier}.hsx`),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          try {
            const stat = statSync(candidate);
            if (stat.isFile()) {
              return {
                name: candidate,
                source: readFileSync(candidate, "utf8"),
              };
            }
          } catch {
            // Ignore filesystem errors and check subsequent candidates.
          }
        }
      }
      return undefined;
    },
  };
}

interface JsonRpcMessage {
  readonly id?: number | string;
  readonly jsonrpc: "2.0";
  readonly method?: string;
  readonly params?: any;
}

export function startLspServer(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: LspServerOptions = {},
): LspServer {
  const documents = new Map<string, string>();
  let isInitialized = false;
  let isShutdown = false;
  let buffer = Buffer.alloc(0);

  const send = (message: unknown): void => {
    const json = JSON.stringify(message);
    const bytes = Buffer.from(json, "utf8");
    output.write(`Content-Length: ${bytes.length}\r\n\r\n${json}`);
  };

  const validateAndPublish = (uri: string, source: string): void => {
    const lineIdx = lineIndex(source);
    const diagnostics: LspDiagnostic[] = [];

    const parsed = parseProgram(source);
    for (const diag of parsed.diagnostics) {
      diagnostics.push({
        ...(diag.code ? { code: diag.code } : {}),
        message: diag.message,
        range: spanToRange(lineIdx, diag.span),
        severity: 1,
        source: "hsx",
      });
    }

    if (parsed.diagnostics.length === 0) {
      const host = createHostForUri(uri, options.host);
      const resolved = resolveProgramModules(parsed.program, host);
      if (!resolved.ok) {
        for (const issue of resolved.issues) {
          diagnostics.push({
            code: issue.code,
            message: issue.message,
            range: spanToRange(lineIdx, issue.span),
            severity: 1,
            source: "hsx",
          });
        }
      } else {
        const checked = checkGeneralProgram(resolved.program);
        for (const diag of checked.diagnostics) {
          if (!resolved.origins.has(diag.span)) {
            diagnostics.push({
              code: diag.code,
              message: diag.message,
              range: spanToRange(lineIdx, diag.span),
              severity: diag.severity === "warning" ? 2 : 1,
              source: "hsx",
            });
          }
        }
      }
    }

    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        diagnostics,
        uri,
      },
    });
  };

  const handleMessage = (msg: JsonRpcMessage): void => {
    const { id, method, params } = msg;

    // Requests (id is present)
    if (id !== undefined) {
      if (isShutdown) {
        send({
          error: {
            code: -32600,
            message: "Invalid request: server is shutting down",
          },
          id,
          jsonrpc: "2.0",
        });
        return;
      }

      if (!isInitialized) {
        if (method !== "initialize") {
          send({
            error: {
              code: -32002,
              message: "Server not initialized",
            },
            id,
            jsonrpc: "2.0",
          });
          return;
        }

        isInitialized = true;
        send({
          id,
          jsonrpc: "2.0",
          result: {
            capabilities: {
              documentFormattingProvider: true,
              textDocumentSync: 1,
            },
            serverInfo: {
              name: "hsx-lsp",
              version: "1.0.0",
            },
          },
        });
        return;
      }

      if (method === "initialize") {
        send({
          id,
          jsonrpc: "2.0",
          result: {
            capabilities: {
              documentFormattingProvider: true,
              textDocumentSync: 1,
            },
            serverInfo: {
              name: "hsx-lsp",
              version: "1.0.0",
            },
          },
        });
        return;
      }

      if (method === "shutdown") {
        isShutdown = true;
        send({
          id,
          jsonrpc: "2.0",
          result: null,
        });
        return;
      }

      if (method === "textDocument/formatting") {
        const uri = params?.textDocument?.uri;
        const source = uri ? documents.get(uri) : undefined;
        if (!source) {
          send({ id, jsonrpc: "2.0", result: null });
          return;
        }
        const formatted = format(source);
        if (!formatted.ok) {
          send({ id, jsonrpc: "2.0", result: null });
          return;
        }
        if (formatted.formatted === source) {
          send({ id, jsonrpc: "2.0", result: [] });
          return;
        }
        const lines = lineIndex(source);
        send({
          id,
          jsonrpc: "2.0",
          result: [
            {
              newText: formatted.formatted,
              range: {
                end: offsetToPosition(lines, source.length),
                start: { character: 0, line: 0 },
              },
            },
          ],
        });
        return;
      }

      send({
        error: {
          code: -32601,
          message: `Method not found: ${method ?? "unknown"}`,
        },
        id,
        jsonrpc: "2.0",
      });
      return;
    }

    // Notifications (id is undefined)
    if (method === "exit") {
      const code = isShutdown ? 0 : 1;
      if (options.onExit) {
        options.onExit(code);
      } else {
        process.exit(code);
      }
      return;
    }

    if (isShutdown || !isInitialized) {
      return;
    }

    if (method === "initialized") {
      return;
    }

    if (method === "textDocument/didOpen") {
      const doc = params?.textDocument;
      if (doc?.uri && typeof doc.text === "string") {
        documents.set(doc.uri, doc.text);
        validateAndPublish(doc.uri, doc.text);
      }
      return;
    }

    if (method === "textDocument/didChange") {
      const uri = params?.textDocument?.uri;
      const changes = params?.contentChanges;
      if (!uri || !Array.isArray(changes) || changes.length === 0) {
        // Empty contentChanges keeps the document and republishes nothing.
        return;
      }
      // Full sync only; an incremental entry would replace the document with a fragment.
      const hasIncremental = changes.some(
        (change: any) =>
          change && typeof change === "object" && "range" in change,
      );
      if (hasIncremental) {
        return;
      }
      const lastChange = changes[changes.length - 1];
      if (lastChange && typeof lastChange.text === "string") {
        documents.set(uri, lastChange.text);
        validateAndPublish(uri, lastChange.text);
      }
      return;
    }

    if (method === "textDocument/didClose") {
      const uri = params?.textDocument?.uri;
      if (uri) {
        documents.delete(uri);
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            diagnostics: [],
            uri,
          },
        });
      }
      return;
    }
  };

  const processBuffer = (): void => {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const headerText = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const contentLength = parseInt(match[1] as string, 10);
      if (Number.isNaN(contentLength) || contentLength < 0) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const totalLength = headerEnd + 4 + contentLength;
      if (buffer.length < totalLength) {
        break;
      }
      const bodyBytes = buffer.subarray(headerEnd + 4, totalLength);
      buffer = buffer.subarray(totalLength);
      const bodyStr = bodyBytes.toString("utf8");
      try {
        const msg = JSON.parse(bodyStr) as JsonRpcMessage;
        handleMessage(msg);
      } catch {
        // Ignore unparseable JSON payload.
      }
    }
  };

  const flushPending = (): void => {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const bodyStr = buffer
        .subarray(headerEnd + 4)
        .toString("utf8")
        .trim();
      if (bodyStr.length > 0) {
        try {
          const msg = JSON.parse(bodyStr) as JsonRpcMessage;
          handleMessage(msg);
        } catch {
          // Ignore unparseable body.
        }
      }
    }
  };

  const onData = (chunk: Buffer | string): void => {
    const incoming =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    buffer = Buffer.concat([buffer, incoming]);
    processBuffer();
  };

  const onEnd = (): void => {
    processBuffer();
    if (buffer.length > 0) {
      flushPending();
    }
    if (options.onExit) {
      options.onExit(0);
    } else {
      process.exit(0);
    }
  };

  input.on("data", onData);
  input.on("end", onEnd);

  return {
    stop(): void {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
    },
  };
}
