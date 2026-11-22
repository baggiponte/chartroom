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

export interface HandlerDeps {
  model: ModelCall;
  init: Init;
  page: string;
  log: (message: string) => void;
  /** Called once the page sends or cancels: the prompt goes back to the agent and the process exits. */
  finish: (code: ExitCode, prompt: string) => void;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The text the server prints for `prompt`: nothing for nothing, and always ending in a newline. */
export const printed = (prompt: string): string => (prompt ? (prompt.endsWith("\n") ? prompt : prompt + "\n") : "");

// Rejects a body that is not JSON or not shaped like `schema`, which the request handler answers with a 400.
async function body<S extends Schema>(req: IncomingMessage, schema: S): Promise<Infer<S>> {
  const raw = await readAll(req);
  const data: unknown = raw ? JSON.parse(raw) : {};
  check(data, schema, "body");
  return data;
}

function send(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function createHandler({ model, init, page, log, finish }: HandlerDeps) {
  /** Answers a model-backed route: 409 when a newer request in the same slot took over, 500 for any other failure. */
  async function answer<T>(res: ServerResponse, work: () => Promise<T>, done: (data: T) => string): Promise<void> {
    const t0 = Date.now();
    try {
      const data = await work();
      log(`${done(data)} in ${String(Date.now() - t0)} ms`);
      send(res, 200, data);
    } catch (e) {
      if (e instanceof SupersededError) {
        send(res, 409, { error: e.message } satisfies Failure);
        return;
      }
      log(errorMessage(e));
      send(res, 500, { error: errorMessage(e) } satisfies Failure);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    switch (`${req.method ?? ""} ${url.pathname}`) {
      case "GET /":
      case "GET /index.html":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page);
        return;
      case "GET /api/init":
        send(res, 200, init);
        return;
      case "POST /api/analyze": {
        const { text = "", settled = [], answers = [], asked = [], more = false } = await body(req, BODY.analyze);
        await answer(
          res,
          () => analyze(model, { text, settled, answers, asked, more }),
          data => `analysed ${String(text.length)} chars, ${String(data.choices.length)} choices`,
        );
        return;
      }
      case "POST /api/explain": {
        const { text = "", question = "", options = [] } = await body(req, BODY.explain);
        await answer(
          res,
          () => explain(model, { text, question, options }),
          () => `explained "${question}"`,
        );
        return;
      }
      case "POST /api/decide": {
        const { text = "", question = "", options = [], answers = [], asked = [] } = await body(req, BODY.decide);
        await answer(
          res,
          () => decide(model, { text, question, options, answers, asked }),
          data => `helped decide "${question}"${data.recommendation ? `: ${data.recommendation.label}` : ""}`,
        );
        return;
      }
      case "POST /api/tidy": {
        const { sentences = [] } = await body(req, BODY.tidy);
        await answer(
          res,
          () => tidy(model, sentences),
          data => `tidied ${String(sentences.length)} sentences into ${String(data.blocks.length)} blocks`,
        );
        return;
      }
      case "POST /api/submit": {
        const { prompt = "" } = await body(req, BODY.submit);
        send(res, 200, { ok: true, sent: printed(prompt) } satisfies Api["/api/submit"]["reply"]);
        finish(0, prompt);
        return;
      }
      case "POST /api/cancel":
        send(res, 200, { ok: true } satisfies Api["/api/cancel"]["reply"]);
        finish(2, "");
        return;
      default:
        send(res, 404, { error: "not found" } satisfies Failure);
    }
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((e: unknown) => {
      send(res, 400, { error: errorMessage(e) } satisfies Failure);
    });
  };
}
