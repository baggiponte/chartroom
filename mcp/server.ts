#!/usr/bin/env node
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { z } from "zod";

import { ROUTES, createApi, errorMessage } from "../skills/chartroom/api.ts";
import type { Answer, Init } from "../skills/chartroom/api.ts";
import { createJobs } from "../skills/chartroom/jobs.ts";
import { createModel } from "../skills/chartroom/model.ts";
import { readPage } from "../skills/chartroom/page.ts";
import { PROVIDERS } from "../skills/chartroom/providers.ts";
import { readSettings } from "../skills/chartroom/settings.ts";

/** One open page: its API, and how to end it once it sends, cancels or times out. */
interface Session {
  api: ReturnType<typeof createApi>;
  end: () => void;
}

const ROOT = join(import.meta.dirname, "..");
const VERSION = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"))).version;
const URI = "ui://chartroom/page.html";
const MIME = "text/html;profile=mcp-app";
const log = (...m: Array<unknown>): void => {
  console.error("[chartroom mcp]", ...m);
};

// The page decides "in the chat" from this tag, so the same file still works in a tab.
const { html, build: BUILD } = readPage();
const PAGE = html.replace('<meta name="build"', '<meta name="host" content="chat">\n<meta name="build"');

// Desktop apps start MCP servers with a bare PATH, so the claude/codex/gemini CLIs wouldn't be found.
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [
    process.env["PATH"],
    join(homedir(), ".local", "bin"),
    join(homedir(), ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
    .filter(Boolean)
    .join(":"),
};

const ChartroomInput = z.object({
  request: z.string().describe("The user's request, verbatim"),
  backend: z
    .string()
    .optional()
    .describe(`Only if the user asked for one: ${Object.keys(PROVIDERS).join(", ")}, or a plugin from their config`),
  model: z.string().optional().describe("Only if the user asked for one"),
  effort: z.enum(["low", "medium", "high"]).optional().describe("Only if the user asked for one"),
  images: z.boolean().optional().describe("Only if the user asked for or against pictures"),
});

const sessions = new Map<string, Session>();
let nextId = 0;

/**
 * Opens a session with the same settings the browser server would read (flags, env, config file), the tool's
 * arguments standing in for flags. Throws, with a message for the user, when they can't be used.
 */
async function open(
  { request, images, ...flags }: z.infer<typeof ChartroomInput>,
  client: string,
): Promise<Init & { session: string }> {
  // The Claude app runs this server without the variables a harness sets for its commands, so `host` asks the
  // MCP client instead: the plugins read its name from here.
  const env = { ...ENV, CHARTROOM_MCP_CLIENT: client };
  const settings = await readSettings(
    [
      "--agent",
      /^codex/i.test(client) ? "Codex" : "Claude",
      ...Object.entries(flags).flatMap(([name, value]) => (value ? [`--${name}`, value] : [])),
      ...(images === undefined ? [] : [images ? "--images" : "--no-images"]),
    ],
    env,
  );
  const { effort, agent } = settings;
  const backend = settings.backend.name;
  const chosen = settings.backend.plugin;
  const model = settings.model || chosen.model || "";
  const id = String(++nextId);
  const jobs = createJobs();
  let timer: NodeJS.Timeout | undefined;
  const end = (): void => {
    jobs.abortAll();
    clearTimeout(timer);
    sessions.delete(id);
  };
  if (settings.timeoutMin > 0) {
    timer = setTimeout(() => {
      log(`session ${id}: no answer after ${String(settings.timeoutMin)} min, closing it`);
      end();
    }, settings.timeoutMin * 60_000).unref();
  }
  const api = createApi({
    model: createModel({ name: backend, backend: chosen, model, effort, env, jobs }),
    log: m => log(`session ${id}: ${m}`),
    finish: end,
  });
  sessions.set(id, { api, end });
  log(`session ${id} for ${client || "an unnamed MCP client"}, backend ${backend}${model ? ` (${model})` : ""}`);
  return {
    session: id,
    draft: request.trim(),
    model: model || backend,
    backend,
    agent,
    images: settings.images,
    build: BUILD,
  };
}

// The page reads structuredContent, the same answer the browser server sends over HTTP.
const apiReply = ({ status, body }: Answer): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  structuredContent: { status, body },
});

function build(): McpServer {
  const server = new McpServer({ name: "chartroom", version: VERSION });

  server.registerResource("chartroom page", URI, { mimeType: MIME, description: "The /chartroom page" }, async () => ({
    contents: [
      {
        uri: URI,
        mimeType: MIME,
        text: PAGE,
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
    "chartroom",
    {
      title: "Chart Room: shape this request",
      description:
        "Shows the user an interactive page inside the chat where they shape a vague request by clicking on it. " +
        "Use it when the user types /chartroom or asks to refine or sharpen their request before you start. " +
        "Pass their request verbatim, minus instructions about the page itself (those go in backend, model, effort, images). " +
        "If it can't start, show the user its error and offer to fix their Chart Room config as it says; don't retry with another backend. " +
        "After calling it, say nothing more and wait: the shaped request arrives as the user's next message. Treat it as their request, every detail a firm constraint.",
      inputSchema: ChartroomInput,
      _meta: { ui: { resourceUri: URI }, "ui/resourceUri": URI },
    },
    async (input): Promise<CallToolResult> => {
      try {
        return {
          content: [
            {
              type: "text",
              text: "The Chart Room page is open in the chat. Wait for the user: their shaped request arrives as their next message.",
            },
          ],
          structuredContent: { ...(await open(input, server.server.getClientVersion()?.name ?? "")) },
        };
      } catch (error) {
        log(errorMessage(error));
        return {
          isError: true,
          content: [{ type: "text", text: `The Chart Room page couldn't start: ${errorMessage(error)}` }],
        };
      }
    },
  );

  server.registerTool(
    "chartroom_api",
    {
      title: "Chart Room page API",
      description: "Used by the Chart Room page itself.",
      inputSchema: z.object({
        session: z.string(),
        path: z.enum(ROUTES),
        body: z.record(z.string(), z.unknown()).optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ session, path, body = {} }): Promise<CallToolResult> => {
      const s = sessions.get(session);
      return apiReply(
        s
          ? await s.api.call(path, body)
          : { status: 410, body: { error: "this Chart Room page has ended. Run /chartroom again" } },
      );
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
      .catch((error: unknown) => {
        log(errorMessage(error));
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    log(`MCP on http://127.0.0.1:${String(typeof address === "object" && address ? address.port : port)}/mcp`);
  });
} else {
  serveStdio(() => build());
}
