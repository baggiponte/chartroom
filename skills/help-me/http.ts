import type { IncomingMessage, ServerResponse } from "node:http";
import { text as readAll } from "node:stream/consumers";

import { type Answer, type ApiDeps, type Failure, type Init, createApi, errorMessage, isRoute } from "./api.ts";

export interface HandlerDeps extends ApiDeps {
  init: Init;
  page: string;
}

function send(res: ServerResponse, { status, body }: Answer): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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
