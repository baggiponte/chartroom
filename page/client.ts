// The page's side of the API: POST a route's body, get its reply, through the help-me server or the chat host.

import type { Api, Failure, Init, Route } from "../skills/help-me/api.ts";
import { state } from "./state.ts";

/** A newer request of the same kind took over; the page drops the older one's answer. */
export type Superseded = Error & { superseded: true };
export const superseded = (): Superseded => Object.assign(new Error("superseded"), { superseded: true as const });

// The serving process swaps in a hash of this file; a file:// page keeps the placeholder. It sits in a meta tag so
// the bundler can't fold the comparison below into a constant.
const BUILD = document.querySelector<HTMLMetaElement>('meta[name="build"]')?.content ?? "%";
export const STALE = "this page doesn't match the running help-me server. Run /help-me again to restart it";
export const staleFor = (init: Pick<Init, "build">): boolean => !BUILD.startsWith("%") && init.build !== BUILD;

// oxlint-disable typescript/no-unsafe-type-assertion -- replies from the page's own server, which Api describes
export async function getInit(): Promise<Init> {
  const r = await fetch("/api/init");
  if (!r.ok) {
    throw new Error(r.statusText);
  }
  return (await r.json()) as Init;
}

export async function post<R extends Route>(path: R, body: Api[R]["body"]): Promise<Api[R]["reply"]> {
  if (state.chat) {
    return state.chat.post(path, body);
  }
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as Api[R]["reply"] & Partial<Failure>;
  if (r.status === 409) {
    throw superseded();
  }
  if (r.status === 404 && (await getInit().then(staleFor, () => false))) {
    throw new Error(STALE);
  }
  if (!r.ok) {
    throw new Error(j.error || r.statusText);
  }
  return j;
}
// oxlint-enable typescript/no-unsafe-type-assertion
