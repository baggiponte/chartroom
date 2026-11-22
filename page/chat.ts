// The MCP Apps protocol (https://github.com/modelcontextprotocol/ext-apps, 2026-01-26), written by hand to keep the
// page one file.

import { INIT, REPLY } from "../skills/help-me/api.ts";
import type { Api, Init, Route } from "../skills/help-me/api.ts";
import { check, isRecord } from "../skills/help-me/schema.ts";
import { fits, superseded } from "./client.ts";

export type ChatHost = ReturnType<typeof chatHost>;

export const inChat = (): boolean => document.querySelector<HTMLMetaElement>('meta[name="host"]')?.content === "chat";

const STRING = { type: "string" } as const;
const TEXT = { type: "array", items: { type: "object", properties: { text: STRING } } } as const;
const TOOL_RESULT = {
  type: "object",
  properties: { isError: { type: "boolean" }, content: TEXT, structuredContent: {} },
} as const;
const SESSION_INIT = {
  ...INIT,
  required: [...INIT.required, "session"],
  properties: { ...INIT.properties, session: STRING },
} as const;
const API_RESULT = {
  type: "object",
  properties: {
    structuredContent: { type: "object", properties: { status: { type: "number" }, body: {} } },
  },
} as const;

interface Waiting {
  res: (result: unknown) => void;
  rej: (e: Error) => void;
}

const send = (m: Record<string, unknown>): void => {
  window.parent.postMessage({ jsonrpc: "2.0", ...m }, "*");
};
const theme = (ctx: unknown): void => {
  if (isRecord(ctx) && typeof ctx["theme"] === "string") {
    document.documentElement.dataset["theme"] = ctx["theme"];
  }
};

export function chatHost() {
  document.documentElement.classList.add("in-chat");
  const waiting = new Map<number, Waiting>();
  let id = 0;
  let session = "";
  let ready: Promise<void> | undefined;
  const result = Promise.withResolvers<Init & { session: string }>();
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((res, rej) => {
      const i = ++id;
      waiting.set(i, { res, rej });
      send({ id: i, method, params });
    });
  function toolResult(params: unknown): void {
    const r = isRecord(params) ? params : {};
    try {
      check(r, TOOL_RESULT);
    } catch {
      result.reject(new Error("the help-me tool failed"));
      return;
    }
    const content = r.structuredContent;
    try {
      if (r.isError) {
        throw new Error("tool error");
      }
      check(content, SESSION_INIT);
      result.resolve(content);
    } catch {
      result.reject(new Error(r.content?.[0]?.text || "the help-me tool failed"));
    }
  }
  window.addEventListener("message", (e: MessageEvent<unknown>) => {
    const m = e.data;
    if (e.source !== window.parent || !isRecord(m) || m["jsonrpc"] !== "2.0") {
      return;
    }
    const { id: mid, method, params, error } = m;
    const w = typeof mid === "number" ? waiting.get(mid) : undefined;
    if (w && typeof mid === "number" && !method) {
      waiting.delete(mid);
      if (isRecord(error)) {
        w.rej(new Error(String(error["message"])));
      } else {
        w.res(m["result"]);
      }
      return;
    }
    if (method === "ui/notifications/tool-result") {
      toolResult(params);
    } else if (method === "ui/notifications/tool-cancelled") {
      result.reject(new Error("the help-me call was cancelled"));
    } else if (method === "ui/notifications/host-context-changed") {
      theme(params);
    } else if (method === "ui/resource-teardown") {
      send({ id: mid, result: {} });
    } else if (mid !== undefined && method) {
      send({ id: mid, error: { code: -32601, message: "method not found" } });
    }
  });
  // Commons links open through the host: a sandboxed frame can't open tabs itself.
  document.addEventListener("click", e => {
    const a = e.target instanceof Element ? e.target.closest("a[href^='http']") : null;
    if (!(a instanceof HTMLAnchorElement)) {
      return;
    }
    e.preventDefault();
    request("ui/open-link", { url: a.href }).catch(() => {});
  });
  const connect = (): Promise<void> =>
    (ready ??= request("ui/initialize", {
      appInfo: { name: "prompt-shaper", version: "1" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    }).then(r => {
      theme(isRecord(r) ? r["hostContext"] : undefined);
      send({ method: "ui/notifications/initialized", params: {} });
      // the page lays itself out in the frame's height (100vh), so ask for a fixed one rather than measuring
      send({ method: "ui/notifications/size-changed", params: { height: 680 } });
    }));
  void connect();
  return {
    request,
    /** Why connecting to the chat failed, to show instead of the demo. */
    failed: "",
    async init(): Promise<Init> {
      await ready;
      const j = await result.promise;
      session = j.session;
      return j;
    },
    async post<R extends Route>(path: R, body: Api[R]["body"]): Promise<Api[R]["reply"]> {
      const r = await request("tools/call", { name: "help_me_api", arguments: { session, path, body } });
      check(r, API_RESULT);
      const { status = 500, body: j } = r.structuredContent ?? {};
      if (status === 409) {
        throw superseded();
      }
      if (status >= 400) {
        const error = isRecord(j) ? j["error"] : undefined;
        throw new Error(typeof error === "string" && error ? error : `error ${String(status)}`);
      }
      return fits(j, REPLY[path]);
    },
  };
}
