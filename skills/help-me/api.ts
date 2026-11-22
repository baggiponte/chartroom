// The page's HTTP API: what each route takes and returns, and the handler that answers it.

import type { IncomingMessage, ServerResponse } from "node:http";
import { text as readAll } from "node:stream/consumers";

import { type ModelCall, SupersededError } from "./model.ts";
import { type Infer, type Schema, check } from "./schema.ts";
import { analyze, decide, explain, tidy } from "./tasks.ts";

const STRING = { type: "string" } as const;
const STRINGS = { type: "array", items: STRING } as const;
const BOOLEAN = { type: "boolean" } as const;

// Every field is optional, with its default where the handler reads it; a field that is there must have this shape.
const BODY = {
  analyze: {
    type: "object",
    properties: { text: STRING, settled: STRINGS, answers: STRINGS, asked: STRINGS, more: BOOLEAN },
  },
  explain: { type: "object", properties: { text: STRING, question: STRING, options: STRINGS } },
  decide: {
    type: "object",
    properties: {
      text: STRING,
      question: STRING,
      options: STRINGS,
      answers: { type: "array", items: { type: "object", required: ["q", "a"], properties: { q: STRING, a: STRING } } },
      asked: STRINGS,
    },
  },
  tidy: { type: "object", properties: { sentences: STRINGS } },
  submit: { type: "object", properties: { prompt: STRING } },
} as const satisfies Record<string, Schema>;

export type ExitCode = 0 | 1 | 2 | 3;

export interface Init {
  draft: string;
  model: string;
  backend: string;
  agent: string;
  images: boolean;
  build: string;
}

/** Every POST route, with the body it takes and what it answers with a 200. */
export interface Api {
  "/api/analyze": { body: Infer<typeof BODY.analyze>; reply: Awaited<ReturnType<typeof analyze>> };
  "/api/explain": { body: Infer<typeof BODY.explain>; reply: Awaited<ReturnType<typeof explain>> };
  "/api/decide": { body: Infer<typeof BODY.decide>; reply: Awaited<ReturnType<typeof decide>> };
  "/api/tidy": { body: Infer<typeof BODY.tidy>; reply: Awaited<ReturnType<typeof tidy>> };
  /** `sent` is exactly what the server printed for the agent. */
  "/api/submit": { body: Infer<typeof BODY.submit>; reply: { ok: true; sent: string } };
  "/api/cancel": { body: Record<string, never>; reply: { ok: true } };
}
export type Route = keyof Api;

/** What every failed route answers: 400 for a body it can't read, 409 when superseded, 500 when the model failed. */
export interface Failure {
  error: string;
}

export interface ApiDeps {
  model: ModelCall;
  log: (message: string) => void;
  /** Called once the page sends or cancels, with what goes back to the agent. */
  finish: (code: ExitCode, prompt: string) => void;
}

export interface HandlerDeps extends ApiDeps {
  init: Init;
  page: string;
}

/** What a route answers: the HTTP status and the JSON body, whichever way the page reached it. */
export interface Answer {
  status: number;
  body: unknown;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The text the server prints for `prompt`: nothing for nothing, and always ending in a newline. */
export const printed = (prompt: string): string => (prompt ? (prompt.endsWith("\n") ? prompt : prompt + "\n") : "");

/** Rejects a body that is not shaped like `schema`, which `call` answers with a 400. */
function read<S extends Schema>(data: unknown, schema: S): Infer<S> {
  check(data, schema, "body");
  return data;
}

/**
 * The page's API without HTTP around it, so the browser server and the MCP App answer the same way: `call` takes a
 * route and its parsed JSON body, and never throws.
 */
export function createApi({ model, log, finish }: ApiDeps) {
  /** Answers a model-backed route: 409 when a newer request in the same slot took over, 500 for any other failure. */
  async function answer<T>(work: () => Promise<T>, done: (data: T) => string): Promise<Answer> {
    const t0 = Date.now();
    try {
      const data = await work();
      log(`${done(data)} in ${String(Date.now() - t0)} ms`);
      return { status: 200, body: data };
    } catch (e) {
      if (e instanceof SupersededError) {
        return { status: 409, body: { error: e.message } satisfies Failure };
      }
      log(errorMessage(e));
      return { status: 500, body: { error: errorMessage(e) } satisfies Failure };
    }
  }

  const routes: { [R in Route]: (data: unknown) => Answer | Promise<Answer> } = {
    "/api/analyze": data => {
      const { text = "", settled = [], answers = [], asked = [], more = false } = read(data, BODY.analyze);
      return answer(
        () => analyze(model, { text, settled, answers, asked, more }),
        reply => `analysed ${String(text.length)} chars, ${String(reply.choices.length)} choices`,
      );
    },
    "/api/explain": data => {
      const { text = "", question = "", options = [] } = read(data, BODY.explain);
      return answer(
        () => explain(model, { text, question, options }),
        () => `explained "${question}"`,
      );
    },
    "/api/decide": data => {
      const { text = "", question = "", options = [], answers = [], asked = [] } = read(data, BODY.decide);
      return answer(
        () => decide(model, { text, question, options, answers, asked }),
        reply => `helped decide "${question}"${reply.recommendation ? `: ${reply.recommendation.label}` : ""}`,
      );
    },
    "/api/tidy": data => {
      const { sentences = [] } = read(data, BODY.tidy);
      return answer(
        () => tidy(model, sentences),
        reply => `tidied ${String(sentences.length)} sentences into ${String(reply.blocks.length)} blocks`,
      );
    },
    "/api/submit": data => {
      const { prompt = "" } = read(data, BODY.submit);
      finish(0, prompt);
      return { status: 200, body: { ok: true, sent: printed(prompt) } satisfies Api["/api/submit"]["reply"] };
    },
    "/api/cancel": () => {
      finish(2, "");
      return { status: 200, body: { ok: true } satisfies Api["/api/cancel"]["reply"] };
    },
  };

  return {
    async call(path: Route, data: unknown): Promise<Answer> {
      try {
        return await routes[path](data);
      } catch (e) {
        return { status: 400, body: { error: errorMessage(e) } satisfies Failure };
      }
    },
  };
}

const ROUTES = new Set<string>([
  "/api/analyze",
  "/api/explain",
  "/api/decide",
  "/api/tidy",
  "/api/submit",
  "/api/cancel",
] satisfies Route[]);
export const isRoute = (path: string): path is Route => ROUTES.has(path);

function send(res: ServerResponse, { status, body: obj }: Answer): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** The browser server's request handler: the page, /api/init, and `createApi` behind POST. */
export function createHandler({ init, page, ...deps }: HandlerDeps) {
  const api = createApi(deps);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    const at = `${req.method ?? ""} ${pathname}`;
    if (at === "GET /" || at === "GET /index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page);
    } else if (at === "GET /api/init") {
      send(res, { status: 200, body: init });
    } else if (req.method === "POST" && isRoute(pathname)) {
      const raw = await readAll(req);
      send(res, await api.call(pathname, raw ? JSON.parse(raw) : {}));
    } else {
      send(res, { status: 404, body: { error: "not found" } satisfies Failure });
    }
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((e: unknown) => {
      send(res, { status: 400, body: { error: errorMessage(e) } satisfies Failure });
    });
  };
}
