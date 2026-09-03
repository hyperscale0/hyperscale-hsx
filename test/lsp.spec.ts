import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { format } from "../src/format.ts";
import { type LspServerOptions, startLspServer } from "../src/lsp/server.ts";

class LspTestClient {
  private buffer = Buffer.alloc(0);
  private queue: any[] = [];
  private waiters: ((msg: any) => void)[] = [];
  readonly clientInput: PassThrough;
  readonly clientOutput: PassThrough;
  readonly server: ReturnType<typeof startLspServer>;

  constructor(options: LspServerOptions = {}) {
    this.clientInput = new PassThrough();
    this.clientOutput = new PassThrough();
    this.server = startLspServer(this.clientInput, this.clientOutput, {
      onExit: () => undefined,
      ...options,
    });

    this.clientOutput.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  private drain(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(match[1] as string, 10);
      if (this.buffer.length < headerEnd + 4 + len) break;
      const body = this.buffer
        .subarray(headerEnd + 4, headerEnd + 4 + len)
        .toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + len);
      const parsed = JSON.parse(body);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(parsed);
      } else {
        this.queue.push(parsed);
      }
    }
  }

  send(msg: unknown): void {
    const json = JSON.stringify(msg);
    const bytes = Buffer.from(json, "utf8");
    this.clientInput.write(`Content-Length: ${bytes.length}\r\n\r\n${json}`);
  }

  sendRaw(raw: string): void {
    this.clientInput.write(raw);
  }

  async readNext(timeoutMs = 2000): Promise<any> {
    const next = this.queue.shift();
    if (next !== undefined) return next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timeout waiting for LSP response"));
      }, timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  async hasNoMessage(timeoutMs = 100): Promise<boolean> {
    if (this.queue.length > 0) return false;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(this.queue.length === 0);
      }, timeoutMs);
    });
  }

  stop(): void {
    this.server.stop();
  }
}

describe("LSP server over stdio", () => {
  it("completes initialize handshake and announces capabilities", async () => {
    const client = new LspTestClient();
    try {
      client.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      const response = await client.readNext();
      expect(response.id).toBe(1);
      expect(response.result).toMatchObject({
        capabilities: {
          documentFormattingProvider: true,
          textDocumentSync: 1,
        },
        serverInfo: {
          name: "hsx-lsp",
          version: "1.0.0",
        },
      });

      client.send({
        jsonrpc: "2.0",
        method: "initialized",
        params: {},
      });
    } finally {
      client.stop();
    }
  });

  it("publishes one diagnostic with correct range and code, updates on didChange, and clears on didClose", async () => {
    const client = new LspTestClient();
    const uri = "file:///workspace/sample.hsx";
    try {
      client.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      await client.readNext();

      const badSource = `program badName "Bad Name"
instrument test {
  title: "Test"; fields {}
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
`;
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            languageId: "hsx",
            text: badSource,
            uri,
            version: 1,
          },
        },
      });

      const openNotice = await client.readNext();
      expect(openNotice.method).toBe("textDocument/publishDiagnostics");
      expect(openNotice.params.uri).toBe(uri);
      expect(openNotice.params.diagnostics).toHaveLength(1);
      expect(openNotice.params.diagnostics[0]).toMatchObject({
        code: "HSX1003",
        range: {
          end: { character: 15, line: 0 },
          start: { character: 8, line: 0 },
        },
        severity: 1,
        source: "hsx",
      });

      const fixedSource = `program bad_name "Bad Name"
instrument test {
  title: "Test"; fields {}
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
`;
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          contentChanges: [{ text: fixedSource }],
          textDocument: { uri, version: 2 },
        },
      });

      const changeNotice = await client.readNext();
      expect(changeNotice.method).toBe("textDocument/publishDiagnostics");
      expect(changeNotice.params.uri).toBe(uri);
      expect(changeNotice.params.diagnostics).toEqual([]);

      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri } },
      });

      const closeNotice = await client.readNext();
      expect(closeNotice.method).toBe("textDocument/publishDiagnostics");
      expect(closeNotice.params.uri).toBe(uri);
      expect(closeNotice.params.diagnostics).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("returns a text edit matching format output", async () => {
    const client = new LspTestClient();
    const uri = "file:///workspace/format_target.hsx";
    try {
      client.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      await client.readNext();

      const unformatted = `program    test_program   "Test Program"
party   buyer:   person
instrument   test   {
title: "Test"; fields {}
lifecycle { states created; initial created; }
action create { moves: []; steps: []; }
}
`;
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            languageId: "hsx",
            text: unformatted,
            uri,
            version: 1,
          },
        },
      });
      await client.readNext();

      client.send({
        id: 2,
        jsonrpc: "2.0",
        method: "textDocument/formatting",
        params: {
          options: { insertSpaces: true, tabSize: 2 },
          textDocument: { uri },
        },
      });

      const response = await client.readNext();
      expect(response.id).toBe(2);
      expect(response.result).toHaveLength(1);
      const expectedFormatted = format(unformatted);
      expect(expectedFormatted.ok).toBe(true);
      if (expectedFormatted.ok) {
        expect(response.result[0].newText).toBe(expectedFormatted.formatted);
      }
      expect(response.result[0].range.start).toEqual({ character: 0, line: 0 });
    } finally {
      client.stop();
    }
  });

  it("ignores malformed Content-Length and handles unknown methods without terminating", async () => {
    const client = new LspTestClient();
    try {
      client.sendRaw('Content-Length: not-a-number\r\n\r\n{"ignore":true}');

      client.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      await client.readNext();

      client.send({
        jsonrpc: "2.0",
        method: "custom/unknownNotification",
        params: {},
      });

      client.send({
        id: 42,
        jsonrpc: "2.0",
        method: "custom/unknownRequest",
        params: {},
      });

      const response = await client.readNext();
      expect(response.id).toBe(42);
      expect(response.error).toMatchObject({
        code: -32601,
        message: "Method not found: custom/unknownRequest",
      });

      client.send({
        id: 43,
        jsonrpc: "2.0",
        method: "shutdown",
        params: null,
      });
      const shutdownResponse = await client.readNext();
      expect(shutdownResponse.id).toBe(43);
      expect(shutdownResponse.result).toBeNull();
    } finally {
      client.stop();
    }
  });

  it("resolves standard library modules without spurious import diagnostics", async () => {
    const client = new LspTestClient();
    const uri = "file:///workspace/std_import.hsx";
    try {
      client.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      await client.readNext();

      const source = `program payer_fee_transfer "Payer fee transfer"
import { instant_transfer } from "std/settlements"

party student: person
party tutor: business

settlement lesson_payment = instant_transfer {
  payer: student
  payee: tutor
  amount: lessonPrice: money(SAR)
  fees { student: 2.5% }
}
`;
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            languageId: "hsx",
            text: source,
            uri,
            version: 1,
          },
        },
      });

      const notice = await client.readNext();
      expect(notice.method).toBe("textDocument/publishDiagnostics");
      expect(notice.params.uri).toBe(uri);
      expect(notice.params.diagnostics).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("request before initialize answers -32002", async () => {
    const client = new LspTestClient();
    try {
      client.send({
        id: 10,
        jsonrpc: "2.0",
        method: "textDocument/formatting",
        params: {
          textDocument: { uri: "file:///workspace/sample.hsx" },
        },
      });
      const response = await client.readNext();
      expect(response.id).toBe(10);
      expect(response.error).toMatchObject({
        code: -32002,
        message: "Server not initialized",
      });
    } finally {
      client.stop();
    }
  });

  it("notification before initialize publishes nothing", async () => {
    const client = new LspTestClient();
    try {
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            languageId: "hsx",
            text: 'program badName "Bad"\n',
            uri: "file:///workspace/sample.hsx",
            version: 1,
          },
        },
      });
      expect(await client.hasNoMessage(100)).toBe(true);
    } finally {
      client.stop();
    }
  });

  it("request after shutdown answers -32600", async () => {
    const client = new LspTestClient();
    try {
      client.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      await client.readNext();

      client.send({
        id: 2,
        jsonrpc: "2.0",
        method: "shutdown",
        params: null,
      });
      const shutdownResponse = await client.readNext();
      expect(shutdownResponse.id).toBe(2);
      expect(shutdownResponse.result).toBeNull();

      client.send({
        id: 3,
        jsonrpc: "2.0",
        method: "textDocument/formatting",
        params: {
          textDocument: { uri: "file:///workspace/sample.hsx" },
        },
      });
      const response = await client.readNext();
      expect(response.id).toBe(3);
      expect(response.error).toMatchObject({
        code: -32600,
        message: "Invalid request: server is shutting down",
      });
    } finally {
      client.stop();
    }
  });

  it("exit after shutdown calls onExit(0), exit without shutdown calls onExit(1)", async () => {
    let exitCodeNoShutdown: number | undefined;
    const clientA = new LspTestClient({
      onExit: (code) => {
        exitCodeNoShutdown = code;
      },
    });
    try {
      clientA.send({
        jsonrpc: "2.0",
        method: "exit",
        params: {},
      });
      expect(exitCodeNoShutdown).toBe(1);
    } finally {
      clientA.stop();
    }

    let exitCodeAfterShutdown: number | undefined;
    const clientB = new LspTestClient({
      onExit: (code) => {
        exitCodeAfterShutdown = code;
      },
    });
    try {
      clientB.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      await clientB.readNext();

      clientB.send({
        id: 2,
        jsonrpc: "2.0",
        method: "shutdown",
        params: null,
      });
      await clientB.readNext();

      clientB.send({
        jsonrpc: "2.0",
        method: "exit",
        params: {},
      });
      expect(exitCodeAfterShutdown).toBe(0);
    } finally {
      clientB.stop();
    }
  });

  it("formatting a clean document returns []", async () => {
    const client = new LspTestClient();
    const uri = "file:///workspace/clean.hsx";
    try {
      client.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      await client.readNext();

      const cleanSource = `program clean_program "Clean Program";
party buyer: person;
instrument test {
  title: "Test";
  fields {}
  lifecycle {
    states created;
    initial created;
  }
  action create {
    moves: [];
    steps: [];
  }
}
`;
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            languageId: "hsx",
            text: cleanSource,
            uri,
            version: 1,
          },
        },
      });
      await client.readNext();

      client.send({
        id: 2,
        jsonrpc: "2.0",
        method: "textDocument/formatting",
        params: {
          options: { insertSpaces: true, tabSize: 2 },
          textDocument: { uri },
        },
      });
      const response = await client.readNext();
      expect(response.id).toBe(2);
      expect(response.result).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("an incremental didChange leaves diagnostics unchanged", async () => {
    const client = new LspTestClient();
    const uri = "file:///workspace/sample_incremental.hsx";
    try {
      client.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      await client.readNext();

      const badSource = `program badName "Bad Name"
instrument test {
  title: "Test"; fields {}
  lifecycle { states created; initial created; }
  action create { moves: []; steps: []; }
}
`;
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            languageId: "hsx",
            text: badSource,
            uri,
            version: 1,
          },
        },
      });
      const openNotice = await client.readNext();
      expect(openNotice.params.diagnostics).toHaveLength(1);

      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          contentChanges: [
            {
              range: {
                end: { character: 15, line: 0 },
                start: { character: 8, line: 0 },
              },
              text: "bad_name",
            },
          ],
          textDocument: { uri, version: 2 },
        },
      });

      expect(await client.hasNoMessage(100)).toBe(true);

      client.send({
        id: 2,
        jsonrpc: "2.0",
        method: "textDocument/formatting",
        params: {
          options: { insertSpaces: true, tabSize: 2 },
          textDocument: { uri },
        },
      });
      const formatResponse = await client.readNext();
      expect(formatResponse.id).toBe(2);
      expect(formatResponse.result[0].newText).toContain("program badName");
    } finally {
      client.stop();
    }
  });

  it("a relative import of a missing module produces HSX1006 with the same message the CLI prints", async () => {
    const client = new LspTestClient();
    const uri = "file:///workspace/relative_missing.hsx";
    try {
      client.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {} },
      });
      await client.readNext();

      const source = `program test_missing "Test Missing"
import { helper } from "./missing_module"
`;
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            languageId: "hsx",
            text: source,
            uri,
            version: 1,
          },
        },
      });

      const notice = await client.readNext();
      expect(notice.method).toBe("textDocument/publishDiagnostics");
      expect(notice.params.uri).toBe(uri);
      expect(notice.params.diagnostics).toHaveLength(1);
      expect(notice.params.diagnostics[0]).toMatchObject({
        code: "HSX1006",
        message: "module ./missing_module cannot be resolved",
        severity: 1,
        source: "hsx",
      });
    } finally {
      client.stop();
    }
  });
});
