import { SupersededError } from "./jobs.ts";
import type { ModelCall } from "./model.ts";
import { BOOLEAN, type Infer, STRING, STRINGS, type Schema, check } from "./schema.ts";
import {
  type Analysis,
  type Decision,
  type Explanation,
  type Tidied,
  analyze,
  decide,
  explain,
  tidy,
} from "./tasks.ts";

/** Every POST route, with the body it takes and what it answers with a 200. */
export interface Api {
  "/api/analyze": { body: Infer<typeof BODY.analyze>; reply: Analysis };
  "/api/explain": { body: Infer<typeof BODY.explain>; reply: Explanation };
  "/api/decide": { body: Infer<typeof BODY.decide>; reply: Decision };
  "/api/tidy": { body: Infer<typeof BODY.tidy>; reply: Tidied };
  /** `sent` is exactly what the server printed for the agent. */
  "/api/submit": { body: Infer<typeof BODY.submit>; reply: { ok: true; sent: string } };
  "/api/cancel": { body: Record<string, never>; reply: { ok: true } };
}
export type Route = keyof Api;

/** What `GET /api/init` answers, and what the MCP App's help_me tool returns. */
export interface Init {
  draft: string;
  model: string;
  backend: string;
  agent: string;
  images: boolean;
  /** The hash of the page this process serves, so a page that outlived its server can tell. */
  build: string;
}

/** What a route answers, whichever way the page reached it. */
export interface Answer {
  status: number;
  body: unknown;
}

/** The body of every failed route: 400 for a body it can't read, 409 when superseded, 500 when the model failed. */
export interface Failure {
  error: string;
}

export type ExitCode = 0 | 1 | 2 | 3;

export interface ApiDeps {
  model: ModelCall;
  log: (message: string) => void;
  /** Called once the page sends or cancels, with what goes back to the agent. */
  finish: (code: ExitCode, prompt: string) => void;
}

export const ROUTES = [
  "/api/analyze",
  "/api/explain",
  "/api/decide",
  "/api/tidy",
  "/api/submit",
  "/api/cancel",
] as const satisfies Route[];
export const isRoute = (path: string): path is Route => (ROUTES as readonly string[]).includes(path);

// No field is required: each one's default sits where the route reads it.
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

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The text the server prints for `prompt`: nothing for nothing, and always ending in a newline. */
export const printed = (prompt: string): string => (prompt ? (prompt.endsWith("\n") ? prompt : prompt + "\n") : "");

function read<S extends Schema>(data: unknown, schema: S): Infer<S> {
  check(data, schema, "body");
  return data;
}

/** The page's API without a transport, so the browser server and the MCP App answer the same way. Never throws. */
export function createApi({ model, log, finish }: ApiDeps) {
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
