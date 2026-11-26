// The backend points at a closed port, so model-backed routes fail with a 500, which is what the page would show.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { FAKE_PLUGIN } from "./support/chartroom.ts";

const SERVER = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));

function startMcp(args: Array<string> = [], env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const home = mkdtempSync(join(tmpdir(), "chartroom-mcp-test-"));
  mkdirSync(join(home, ".config", "chartroom"), { recursive: true });
  writeFileSync(join(home, ".config", "chartroom", "config.json"), JSON.stringify({ plugins: { fake: FAKE_PLUGIN } }));
  return spawn(process.execPath, [SERVER, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      FAKE_MODEL_URL: "http://127.0.0.1:9",
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

async function connect(t: TestContext, env: NodeJS.ProcessEnv = {}, clientName = "test") {
  const child = startMcp([], env);
  t.after(() => child.kill());
  const client = stdioClient(child);
  await client.request("initialize", { ...INITIALIZE, clientInfo: { name: clientName, version: "1" } });
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
  test("offers the chartroom tool and the page's own API tool", async t => {
    const client = await connect(t);
    const { tools } = ToolList.parse(await client.request("tools/list", {}));
    assert.deepEqual(tools.map(tool => tool.name).toSorted(), ["chartroom", "chartroom_api"]);
  });

  test("chartroom opens a session with the request, and the page's API reaches it until it ends", async t => {
    const client = await connect(t);
    const call = (name: string, args: object): Promise<unknown> =>
      client.request("tools/call", { name, arguments: args });

    const { structuredContent } = Started.parse(
      await call("chartroom", { request: "help me pick a bike", backend: "fake" }),
    );
    assert.equal(structuredContent.draft, "help me pick a bike");
    assert.equal(structuredContent.backend, "fake");

    const cancel = { session: structuredContent.session, path: "/api/cancel" };
    const cancelled = ApiReply.parse(await call("chartroom_api", cancel));
    assert.deepEqual(cancelled.structuredContent, { status: 200, body: { ok: true } });

    const ended = ApiReply.parse(await call("chartroom_api", cancel));
    assert.equal(ended.structuredContent.status, 410);
  });

  test("a model that can't be reached is a 500 for the page, and the server keeps running", async t => {
    const client = await connect(t);
    const call = (name: string, args: object): Promise<unknown> =>
      client.request("tools/call", { name, arguments: args });
    const { structuredContent } = Started.parse(await call("chartroom", { request: "a bike", backend: "fake" }));
    const tidy = { session: structuredContent.session, path: "/api/tidy", body: { sentences: ["a.", "b."] } };
    assert.equal(ApiReply.parse(await call("chartroom_api", tidy)).structuredContent.status, 500);
    assert.equal(
      ApiReply.parse(await call("chartroom_api", { ...tidy, body: { sentences: 1 } })).structuredContent.status,
      400,
    );
    const { tools } = ToolList.parse(await client.request("tools/list", {}));
    assert.equal(tools.length, 2);
  });

  test("a setting it can't use is a tool error, not a crash", async t => {
    const client = await connect(t, { CHARTROOM_TIMEOUT_MIN: "soon" });
    const r = z
      .object({ isError: z.literal(true), content: z.tuple([z.object({ text: z.string() })]) })
      .parse(await client.request("tools/call", { name: "chartroom", arguments: { request: "x", backend: "fake" } }));
    assert.match(r.content[0].text, /couldn't start: --timeout-min should be a number/);
  });

  test("in the Claude app, host is the claude backend, though the app sets none of Claude Code's variables", async t => {
    const bin = mkdtempSync(join(tmpdir(), "chartroom-mcp-bin-"));
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const client = await connect(t, { PATH: `${bin}:${process.env["PATH"] ?? ""}` }, "claude-ai");
    const { structuredContent } = Started.parse(
      await client.request("tools/call", { name: "chartroom", arguments: { request: "a bike" } }),
    );
    assert.equal(structuredContent.backend, "claude");
  });

  test("an MCP client no backend claims is a tool error that names it, not a guess", async t => {
    const client = await connect(t, {}, "some-other-app");
    const r = z
      .object({ isError: z.literal(true), content: z.tuple([z.object({ text: z.string() })]) })
      .parse(await client.request("tools/call", { name: "chartroom", arguments: { request: "x" } }));
    assert.match(r.content[0].text, /MCP client "some-other-app", which no backend claims.*Set "backend"/);
  });

  test("serves the page marked as shown inside the chat", async t => {
    const client = await connect(t);
    const page = Page.parse(await client.request("resources/read", { uri: "ui://chartroom/page.html" }));
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
    assert.match(await r.text(), /"serverInfo":\{"name":"chartroom"/);

    assert.equal((await fetch(`${base}/other`)).status, 404);
  });
});
