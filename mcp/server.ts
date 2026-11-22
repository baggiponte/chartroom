#!/usr/bin/env node
// /help-me as an MCP App: the same page, shown inside the chat (Claude web and desktop) instead of a browser tab.
// The help_me tool starts skills/help-me/server.mjs without a browser and proxies the page's /api calls to it,
// so the backends, prompts and config stay in one place. The page hands the shaped request back with ui/message.
//
//   node mcp/server.mjs            stdio, for Claude Desktop's config
//   node mcp/server.mjs --http     streamable HTTP on 127.0.0.1:3917/mcp, to put behind a tunnel for claude.ai
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "help-me");
const VERSION = JSON.parse(readFileSync(join(SKILL, "..", "..", ".claude-plugin", "plugin.json"), "utf8")).version;
const URI = "ui://help-me/page.html";
const MIME = "text/html;profile=mcp-app";
const log = (...m) => console.error("[help-me mcp]", ...m);

// The page decides "in the chat" from this flag, so the same file still works as the browser page.
// The build hash is the one skills/help-me/server.mjs puts in its /api/init, so a cached or outdated page can tell.
const page = () => {
  const src = readFileSync(join(SKILL, "index.html"), "utf8");
  return src
    .replace('"%BUILD%"', JSON.stringify(createHash("sha256").update(src).digest("hex").slice(0, 12)))
    .replace("<script>", "<script>window.__HELP_ME_MCP__ = true;</script>\n<script>");
};

// Desktop apps start MCP servers with a bare PATH, so the claude/codex/gemini CLIs wouldn't be found.
const PATH = [
  process.env.PATH,
  join(homedir(), ".local", "bin"),
  join(homedir(), ".claude", "local"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
]
  .filter(Boolean)
  .join(":");

const sessions = new Map(); // id -> { port, child }
let nextId = 0;

function start({ request, backend, model, effort, images }) {
  const args = [join(SKILL, "server.mjs"), "--stdin", "--no-open", "--agent", "Claude"];
  if (backend) args.push("--backend", backend);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (images !== undefined) args.push(images ? "--images" : "--no-images");
  const child = spawn(process.execPath, args, { env: { ...process.env, PATH }, stdio: ["pipe", "ignore", "pipe"] });
  child.stdin.end(request);
  return new Promise((resolve, reject) => {
    let err = "";
    const fail = why => {
      child.kill();
      reject(new Error(why));
    };
    const t = setTimeout(() => fail("the help-me server didn't start within 20 s"), 20000);
    child.stderr.on("data", d => {
      err += d;
      const m = err.match(/open http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(t);
        resolve({ port: Number(m[1]), child, info: err });
      }
    });
    child.on("exit", code => {
      clearTimeout(t);
      reject(new Error(err.replace(/\[prompt-shaper\] /g, "").trim() || `exited with ${code}`));
    });
    child.on("error", e => {
      clearTimeout(t);
      reject(e);
    });
  });
}

process.on("exit", () => {
  for (const s of sessions.values()) s.child.kill();
});

function build() {
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
      inputSchema: z.object({
        request: z.string().describe("The user's request, verbatim"),
        backend: z
          .enum(["claude", "codex", "gemini", "anthropic", "openai"])
          .optional()
          .describe("Only if the user asked for one"),
        model: z.string().optional().describe("Only if the user asked for one"),
        effort: z.enum(["low", "medium", "high"]).optional().describe("Only if the user asked for one"),
        images: z.boolean().optional().describe("Only if the user asked for or against pictures"),
      }),
      _meta: { ui: { resourceUri: URI }, "ui/resourceUri": URI },
    },
    async input => {
      let s;
      try {
        s = await start(input);
      } catch (e) {
        log(e.message);
        return { isError: true, content: [{ type: "text", text: `The help-me page couldn't start: ${e.message}` }] };
      }
      const id = String(++nextId);
      sessions.set(id, s);
      s.child.on("exit", () => sessions.delete(id));
      const init = await fetch(`http://127.0.0.1:${s.port}/api/init`).then(r => r.json());
      log(`session ${id} on port ${s.port}, backend ${init.backend}`);
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
    async ({ session, path, body = {} }) => {
      const s = sessions.get(session);
      const out = (status, b) => ({
        content: [{ type: "text", text: JSON.stringify(b) }],
        structuredContent: { status, body: b },
      });
      if (!s) return out(410, { error: "this help-me page has ended. Run /help-me again" });
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return out(r.status, await r.json().catch(() => ({})));
      } catch (e) {
        return out(502, { error: e.message });
      }
    },
  );

  return server;
}

if (process.argv.includes("--http")) {
  const i = process.argv.indexOf("--port");
  const port = Number(i > 0 ? process.argv[i + 1] : process.env.PORT || 3917);
  const handler = createMcpHandler(() => build());
  http
    .createServer(async (req, res) => {
      if (!req.url.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        res.end();
        return;
      }
      for await (const c of response.body) res.write(c);
      res.end();
    })
    .listen(port, "127.0.0.1", () => log(`MCP on http://127.0.0.1:${port}/mcp`));
} else {
  serveStdio(() => build());
}
