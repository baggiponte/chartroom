import { SupersededError } from "./jobs.ts";
import type { ModelCall } from "./model.ts";
import { BOOLEAN, STRING, STRINGS, check } from "./schema.ts";
import type { Infer, Schema } from "./schema.ts";
import { ANALYSIS, DECISION, EXPLANATION, TIDIED, analyze, decide, explain, tidy } from "./tasks.ts";

/** Every POST route, with the body it takes and what it answers with a 200. */
export interface Api {
  "/api/analyze": { body: Infer<typeof BODY.analyze>; reply: Infer<(typeof REPLY)["/api/analyze"]> };
  "/api/explain": { body: Infer<typeof BODY.explain>; reply: Infer<(typeof REPLY)["/api/explain"]> };
  "/api/decide": { body: Infer<typeof BODY.decide>; reply: Infer<(typeof REPLY)["/api/decide"]> };
  "/api/tidy": { body: Infer<typeof BODY.tidy>; reply: Infer<(typeof REPLY)["/api/tidy"]> };
  "/api/submit": { body: Infer<typeof BODY.submit>; reply: Infer<(typeof REPLY)["/api/submit"]> };
  "/api/cancel": { body: Record<string, never>; reply: Infer<(typeof REPLY)["/api/cancel"]> };
}
export type Route = keyof Api;

/** What each route answers with a 200, which the page checks before it uses it. */
export const REPLY = {
  "/api/analyze": ANALYSIS,
  "/api/explain": EXPLANATION,
  "/api/decide": DECISION,
  "/api/tidy": TIDIED,
  // `sent` is exactly what the server printed for the agent.
  "/api/submit": { type: "object", required: ["ok", "sent"], properties: { ok: BOOLEAN, sent: STRING } },
  "/api/cancel": { type: "object", required: ["ok"], properties: { ok: BOOLEAN } },
} as const satisfies Record<Route, Schema>;

/** What `GET /api/init` answers, and what the MCP App's help_me tool returns. */
export const INIT = {
  type: "object",
  required: ["draft", "model", "backend", "agent", "images", "build"],
  properties: {
    draft: STRING,
    model: STRING,
    backend: STRING,
    agent: STRING,
    images: BOOLEAN,
    // the hash of the page this process serves, so a page that outlived its server can tell
    build: STRING,
  },
} as const satisfies Schema;
export type Init = Infer<typeof INIT>;

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
] as const satisfies Array<Route>;
export const isRoute = (path: string): path is Route => (ROUTES as ReadonlyArray<string>).includes(path);

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
    } catch (error) {
      if (error instanceof SupersededError) {
        return { status: 409, body: { error: error.message } satisfies Failure };
      }
      log(errorMessage(error));
      return { status: 500, body: { error: errorMessage(error) } satisfies Failure };
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
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) } satisfies Failure };
      }
    },
  };
}
