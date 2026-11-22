#!/usr/bin/env node
// /help-me as an MCP App: the same page, shown inside the chat (Claude web and desktop) instead of a browser tab.
// The help_me tool starts skills/help-me/server.ts without a browser and proxies the page's /api calls to it,
// so the backends, prompts and config stay in one place. The page hands the shaped request back with ui/message.
//
//   node mcp/server.ts            stdio, for Claude Desktop's config
//   node mcp/server.ts --http     streamable HTTP on 127.0.0.1:3917/mcp, to put behind a tunnel for claude.ai
import { type CallToolResult, McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as z from "zod";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "help-me");
const VERSION = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(join(SKILL, "..", "..", ".claude-plugin", "plugin.json"), "utf8"))).version;
const URI = "ui://help-me/page.html";
const MIME = "text/html;profile=mcp-app";
const log = (...m: unknown[]): void => {
  console.error("[help-me mcp]", ...m);
};
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The page decides "in the chat" from this flag, so the same file still works as the browser page.
// The build hash is the one skills/help-me/server.ts puts in its /api/init, so a cached or outdated page can tell.
const page = (): string => {
  const src = readFileSync(join(SKILL, "index.html"), "utf8");
  return src
    .replace('"%BUILD%"', JSON.stringify(createHash("sha256").update(src).digest("hex").slice(0, 12)))
    .replace("<script>", "<script>window.__HELP_ME_MCP__ = true;</script>\n<script>");
};

// Desktop apps start MCP servers with a bare PATH, so the claude/codex/gemini CLIs wouldn't be found.
const PATH = [
  process.env["PATH"],
  join(homedir(), ".local", "bin"),
  join(homedir(), ".claude", "local"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
]
  .filter(Boolean)
  .join(":");

const HelpMeInput = z.object({
  request: z.string().describe("The user's request, verbatim"),
  backend: z
    .enum(["claude", "codex", "gemini", "anthropic", "openai"])
    .optional()
    .describe("Only if the user asked for one"),
  model: z.string().optional().describe("Only if the user asked for one"),
  effort: z.enum(["low", "medium", "high"]).optional().describe("Only if the user asked for one"),
  images: z.boolean().optional().describe("Only if the user asked for or against pictures"),
});

// What the help-me server's /api/init answers; checked, because it is passed on to the page as the tool's result.
const Init = z.object({
  draft: z.string(),
  model: z.string(),
  backend: z.string(),
  agent: z.string(),
  images: z.boolean(),
  build: z.string(),
});

interface Session {
  port: number;
  child: ChildProcess;
}
const sessions = new Map<string, Session>();
let nextId = 0;

function start({ request, images, ...settings }: z.infer<typeof HelpMeInput>): Promise<Session> {
  const args = [
    join(SKILL, "server.ts"),
    "--stdin",
    "--no-open",
    "--agent",
    "Claude",
    ...Object.entries(settings).flatMap(([name, value]) => (value ? [`--${name}`, value] : [])),
    ...(images === undefined ? [] : [images ? "--images" : "--no-images"]),
  ];
  const child = spawn(process.execPath, args, { env: { ...process.env, PATH }, stdio: ["pipe", "ignore", "pipe"] });
  child.stdin.end(request);
  return new Promise((resolve, reject) => {
    let err = "";
    const fail = (why: string): void => {
      child.kill();
      reject(new Error(why));
    };
    const t = setTimeout(() => fail("the help-me server didn't start within 20 s"), 20000);
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      const m = err.match(/open http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(t);
        resolve({ port: Number(m[1]), child });
      }
    });
    child.on("exit", code => {
      clearTimeout(t);
      reject(new Error(err.replace(/\[prompt-shaper\] /g, "").trim() || `exited with ${String(code)}`));
    });
    child.on("error", e => {
      clearTimeout(t);
      reject(e);
    });
  });
}

process.on("exit", () => {
  for (const s of sessions.values()) {
    s.child.kill();
  }
});

// The page reads the HTTP status and body from structuredContent, as if it had called the help-me server itself.
const apiReply = (status: number, body: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  structuredContent: { status, body },
});

function build(): McpServer {
  const server = new McpServer({ name: "prompt-shaper", version: VERSION });

  server.registerResource("help-me page", URI, { mimeType: MIME, description: "The /help-me page" }, async () => ({
    contents: [
      {
        uri: URI,
        mimeType: MIME,
        text: page(),
        // pictures in Explain me come from Wikimedia Commons
        _meta: {
          ui: {
            csp: {
              connectDomains: ["https://commons.wikimedia.org"],
              resourceDomains: ["https://upload.wikimedia.org"],
            },
            prefersBorder: false,
          },
        },
      },
    ],
  }));

  server.registerTool(
    "help_me",
    {
      title: "Help me shape this request",
      description:
        "Shows the user an interactive page inside the chat where they shape a vague request by clicking on it. " +
        "Use it when the user types /help-me or asks to refine or sharpen their request before you start. " +
        "Pass their request verbatim, minus instructions about the page itself (those go in backend, model, effort, images). " +
        "After calling it, say nothing more and wait: the shaped request arrives as the user's next message. Treat it as their request, every detail a firm constraint.",
      inputSchema: HelpMeInput,
      _meta: { ui: { resourceUri: URI }, "ui/resourceUri": URI },
    },
    async (input): Promise<CallToolResult> => {
      let s: Session;
      try {
        s = await start(input);
      } catch (e) {
        log(errorMessage(e));
        return {
          isError: true,
          content: [{ type: "text", text: `The help-me page couldn't start: ${errorMessage(e)}` }],
        };
      }
      const id = String(++nextId);
      sessions.set(id, s);
      s.child.on("exit", () => sessions.delete(id));
      const init = Init.parse(await (await fetch(`http://127.0.0.1:${String(s.port)}/api/init`)).json());
      log(`session ${id} on port ${String(s.port)}, backend ${init.backend}`);
      return {
        content: [
          {
            type: "text",
            text: "The help-me page is open in the chat. Wait for the user: their shaped request arrives as their next message.",
          },
        ],
        structuredContent: { session: id, ...init },
      };
    },
  );

  // Only the page calls this: it is the page's /api, carried through the host.
  server.registerTool(
    "help_me_api",
    {
      title: "help-me page API",
      description: "Used by the help-me page itself.",
      inputSchema: z.object({
        session: z.string(),
        path: z.enum(["/api/analyze", "/api/explain", "/api/decide", "/api/tidy", "/api/submit", "/api/cancel"]),
        body: z.record(z.string(), z.unknown()).optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ session, path, body = {} }): Promise<CallToolResult> => {
      const s = sessions.get(session);
      if (!s) {
        return apiReply(410, { error: "this help-me page has ended. Run /help-me again" });
      }
      try {
        const r = await fetch(`http://127.0.0.1:${String(s.port)}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return apiReply(r.status, await r.json().catch((): unknown => ({})));
      } catch (e) {
        return apiReply(502, { error: errorMessage(e) });
      }
    },
  );

  return server;
}

async function toWeb(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, v);
    }
  }
  const method = req.method ?? "GET";
  return new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
    method,
    headers,
    ...(["GET", "HEAD"].includes(method) ? {} : { body: await buffer(req) }),
  });
}

async function fromWeb(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const c of response.body) {
      res.write(c);
    }
  }
  res.end();
}

const flags = parseArgs({ options: { http: { type: "boolean" }, port: { type: "string" } } }).values;
if (flags.http) {
  const port = Number(flags.port ?? process.env["PORT"] ?? 3917);
  const handler = createMcpHandler(() => build());
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    toWeb(req)
      .then(async request => fromWeb(await handler.fetch(request), res))
      .catch((e: unknown) => {
        log(errorMessage(e));
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
  });
  server.listen(port, "127.0.0.1", () => {
    // the port actually bound, which differs from the one asked for with --port 0
    const address = server.address();
    log(`MCP on http://127.0.0.1:${String(typeof address === "object" && address ? address.port : port)}/mcp`);
  });
} else {
  serveStdio(() => build());
}
