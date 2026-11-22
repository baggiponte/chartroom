import { INIT, REPLY, errorMessage } from "../skills/help-me/api.ts";
import type { Api, Init, Route } from "../skills/help-me/api.ts";
import { check, isRecord } from "../skills/help-me/schema.ts";
import type { Infer, Schema } from "../skills/help-me/schema.ts";
import { state } from "./state.ts";

/** A newer request of the same kind took over; the page drops the older one's answer. */
export type Superseded = Error & { superseded: true };
export const superseded = (): Superseded => Object.assign(new Error("superseded"), { superseded: true as const });
export const isSuperseded = (e: unknown): e is Superseded => e instanceof Error && "superseded" in e;

// The serving process swaps in a hash of this file; a file:// page keeps the placeholder. It sits in a meta tag so
// the bundler can't fold the comparison below into a constant.
const BUILD = document.querySelector<HTMLMetaElement>('meta[name="build"]')?.content ?? "%";
const RESTART = "Run /help-me again to restart it";
export const STALE = `this page doesn't match the running help-me server. ${RESTART}`;
export const staleFor = (init: Pick<Init, "build">): boolean => !BUILD.startsWith("%") && init.build !== BUILD;

/** Checked here, so a page and a server that drifted apart fail with this message instead of deep in rendering. */
export function fits<S extends Schema>(j: unknown, schema: S): Infer<S> {
  try {
    check(j, schema);
  } catch (error) {
    throw new Error(`the help-me server answered something this page can't read (${errorMessage(error)}). ${RESTART}`, {
      cause: error,
    });
  }
  return j;
}

export async function getInit(): Promise<Init> {
  const r = await fetch("/api/init");
  if (!r.ok) {
    throw new Error(r.statusText);
  }
  return fits(await r.json(), INIT);
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
  const j: unknown = await r.json().catch(() => ({}));
  if (r.status === 409) {
    throw superseded();
  }
  if (r.status === 404 && (await getInit().then(staleFor, () => false))) {
    throw new Error(STALE);
  }
  if (!r.ok) {
    const error = isRecord(j) ? j["error"] : undefined;
    throw new Error(typeof error === "string" && error ? error : r.statusText);
  }
  return fits(j, REPLY[path]);
}
