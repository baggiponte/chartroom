// The MCP App server (mcp/server.ts), driven over stdio and HTTP the way Claude does. No model answers: the backend
// points at a closed port, so model-backed routes fail with a 500, which is what the page would show.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const SERVER = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));

function startMcp(args: string[] = [], env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const home = mkdtempSync(join(tmpdir(), "help-me-mcp-test-"));
  return spawn(process.execPath, [SERVER, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      ANTHROPIC_API_KEY: "test",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      ...env,
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

async function connect(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const child = startMcp([], env);
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

  test("help_me opens a session with the request, and the page's API reaches it until it ends", async t => {
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

    const ended = ApiReply.parse(await call("help_me_api", cancel));
    assert.equal(ended.structuredContent.status, 410);
  });

  test("a model that can't be reached is a 500 for the page, and the server keeps running", async t => {
    const client = await connect(t);
    const call = (name: string, args: object): Promise<unknown> =>
      client.request("tools/call", { name, arguments: args });
    const { structuredContent } = Started.parse(await call("help_me", { request: "a bike", backend: "anthropic" }));
    const tidy = { session: structuredContent.session, path: "/api/tidy", body: { sentences: ["a.", "b."] } };
    assert.equal(ApiReply.parse(await call("help_me_api", tidy)).structuredContent.status, 500);
    assert.equal(
      ApiReply.parse(await call("help_me_api", { ...tidy, body: { sentences: 1 } })).structuredContent.status,
      400,
    );
    const { tools } = ToolList.parse(await client.request("tools/list", {}));
    assert.equal(tools.length, 2);
  });

  test("a setting it can't use is a tool error, not a crash", async t => {
    const client = await connect(t, { PROMPT_SHAPER_TIMEOUT_MIN: "soon" });
    const r = z
      .object({ isError: z.literal(true), content: z.tuple([z.object({ text: z.string() })]) })
      .parse(await client.request("tools/call", { name: "help_me", arguments: { request: "x" } }));
    assert.match(r.content[0].text, /couldn't start: --timeout-min should be a number/);
  });

  test("serves the page marked as shown inside the chat", async t => {
    const client = await connect(t);
    const page = Page.parse(await client.request("resources/read", { uri: "ui://help-me/page.html" }));
    assert.match(page.contents[0].text, /<meta name="host" content="chat">/);
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
