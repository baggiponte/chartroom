// The MCP App server (mcp/server.ts), driven over stdio and HTTP the way Claude does. No model is reached: the help-me
// page it starts points at a closed port, and the tests only open and cancel it.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const SERVER = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));

function startMcp(args: string[] = []): ChildProcessWithoutNullStreams {
  const home = mkdtempSync(join(tmpdir(), "help-me-mcp-test-"));
  return spawn(process.execPath, [SERVER, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      ANTHROPIC_API_KEY: "test",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    },
  });
}

const Response = z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() });

/** A JSON-RPC client over the server's stdio, one JSON message per line. */
function stdioClient(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  let nextId = 0;
  const waiting = new Map<number, (result: unknown) => void>();
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString();
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const message = Response.safeParse(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
      if (message.success) {
        waiting.get(message.data.id)?.(message.data.error ?? message.data.result);
      }
    }
  });
  const write = (message: object): void => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  };
  return {
    request: (method: string, params: object): Promise<unknown> =>
      new Promise(resolve => {
        const id = ++nextId;
        waiting.set(id, resolve);
        write({ id, method, params });
      }),
    notify: (method: string): void => {
      write({ method });
    },
  };
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1" },
};

async function connect(t: TestContext) {
  const child = startMcp();
  t.after(() => child.kill());
  const client = stdioClient(child);
  await client.request("initialize", INITIALIZE);
  client.notify("notifications/initialized");
  return client;
}

const ToolList = z.object({ tools: z.array(z.object({ name: z.string() })) });
const Started = z.object({
  structuredContent: z.object({ session: z.string(), draft: z.string(), backend: z.string() }),
});
const ApiReply = z.object({ structuredContent: z.object({ status: z.number(), body: z.unknown() }) });
const Page = z.object({ contents: z.tuple([z.object({ text: z.string() })]) });

describe("MCP App over stdio", () => {
  test("offers the help_me tool and the page's own API tool", async t => {
    const client = await connect(t);
    const { tools } = ToolList.parse(await client.request("tools/list", {}));
    assert.deepEqual(tools.map(tool => tool.name).toSorted(), ["help_me", "help_me_api"]);
  });

  test("help_me starts a page with the request, and the page's API reaches it until it ends", async t => {
    const client = await connect(t);
    const call = (name: string, args: object): Promise<unknown> =>
      client.request("tools/call", { name, arguments: args });

    const { structuredContent } = Started.parse(
      await call("help_me", { request: "help me pick a bike", backend: "anthropic" }),
    );
    assert.equal(structuredContent.draft, "help me pick a bike");
    assert.equal(structuredContent.backend, "anthropic");

    const cancel = { session: structuredContent.session, path: "/api/cancel" };
    const cancelled = ApiReply.parse(await call("help_me_api", cancel));
    assert.deepEqual(cancelled.structuredContent, { status: 200, body: { ok: true } });

    // the page's server exits after Cancel, so the session is gone shortly after
    await new Promise(resolve => setTimeout(resolve, 500));
    const ended = ApiReply.parse(await call("help_me_api", cancel));
    assert.equal(ended.structuredContent.status, 410);
  });

  test("serves the page marked as shown inside the chat", async t => {
    const client = await connect(t);
    const page = Page.parse(await client.request("resources/read", { uri: "ui://help-me/page.html" }));
    assert.match(page.contents[0].text, /window\.__HELP_ME_MCP__ = true/);
    assert.doesNotMatch(page.contents[0].text, /"%BUILD%"/);
  });
});

describe("MCP App over HTTP", () => {
  test("answers MCP on /mcp and 404 elsewhere", async t => {
    const child = startMcp(["--http", "--port", "0"]);
    t.after(() => child.kill());
    const base = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        const m = /MCP on (http:\/\/127\.0\.0\.1:\d+)\/mcp/.exec(stderr);
        if (m?.[1]) {
          resolve(m[1]);
        }
      });
      child.on("exit", code => {
        reject(new Error(`exited ${String(code)}:\n${stderr}`));
      });
    });

    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE }),
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /"serverInfo":\{"name":"prompt-shaper"/);

    assert.equal((await fetch(`${base}/other`)).status, 404);
  });
});
