import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { BackendCall, RawReply } from "../plugins.ts";

export function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const exts = platform() === "win32" ? ["", ".cmd", ".exe"] : [""];
  return (env["PATH"] ?? "").split(delimiter).some(d => d && exts.some(e => existsSync(join(d, cmd + e))));
}

/** Runs `cmd` and parses its stdout; a failed parse reports the CLI's own output, which says more. */
export function runCli<T>(
  { env, signal }: BackendCall,
  cmd: string,
  argv: ReadonlyArray<string>,
  stdin: string,
  parse: (out: string) => T,
  cwd = tmpdir(),
): Promise<T> {
  return new Promise((resolve, reject) => {
    // The child gets PROMPT_SHAPER_CHILD so a harness that loads this skill doesn't open the page again.
    const child = spawn(cmd, argv, {
      cwd,
      env: { ...env, PROMPT_SHAPER_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", e => {
      reject(new Error(`could not start ${cmd}: ${e.message}`));
    });
    child.on("close", code => {
      try {
        resolve(parse(out));
      } catch (error) {
        // A bare JSON.parse failure ("Unexpected token…") says less than the CLI's own output does.
        const why = error instanceof Error && !error.message.startsWith("Unexpected") ? `${error.message} ` : "";
        reject(new Error(`${cmd} exited ${String(code)}: ${why}${(err || out).slice(0, 400)}`));
      }
    });
    // A CLI that exits before reading stdin would otherwise crash us with EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

export async function runHttp<T>(
  { signal }: BackendCall,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  parse: (reply: unknown) => T,
): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal,
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${new URL(url).host} answered ${String(r.status)}: ${text.slice(0, 400)}`);
  }
  return parse(JSON.parse(text));
}

export const timed = async <T extends RawReply>(run: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  const reply = await run();
  return { ...reply, ms: reply.ms ?? Date.now() - t0 };
};

export const baseUrl = (value: string | undefined, fallback: string): string => (value || fallback).replace(/\/$/, "");
