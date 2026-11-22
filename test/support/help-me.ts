import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text as readAll } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const SERVER = fileURLToPath(new URL("../../skills/help-me/server.ts", import.meta.url));

export interface ModelRequest {
  model: string;
  system: string;
  input: string;
}

/** What the fake model answers with, for the `fake` test plugin. */
export type FakeModel = (req: ModelRequest) => unknown;

export interface FakeApi {
  url: string;
  calls: Array<ModelRequest>;
  close: () => Promise<void>;
}

const ModelRequest = z.object({ model: z.string(), system: z.string(), input: z.string() });

/** The `fake` backend, which every server started here has, asks the model at FAKE_MODEL_URL. */
export const FAKE_PLUGIN = fileURLToPath(new URL("plugins/fake.ts", import.meta.url));

export async function startFakeApi(answer: FakeModel): Promise<FakeApi> {
  const calls: Array<ModelRequest> = [];
  const server: Server = createServer((req, res) => {
    void readAll(req).then(raw => {
      const call = ModelRequest.parse(JSON.parse(raw));
      calls.push(call);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(call)));
    });
  });
  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake API is not listening on a TCP port");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls,
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
      }),
  };
}

export interface HelpMe {
  url: string;
  get: (path: string) => Promise<Response>;
  post: (path: string, body: unknown) => Promise<Response>;
  /** POSTs and parses the JSON answer with `schema`, failing the test if the shape is wrong. */
  ask: <T>(path: string, body: unknown, schema: z.ZodType<T>) => Promise<T>;
  /** Resolves when the process exits, with everything it printed on stdout. */
  exited: Promise<{ code: number | null; stdout: string }>;
  stop: () => void;
}

export interface StartOptions {
  args?: Array<string>;
  env?: Record<string, string>;
  api?: FakeApi;
  /** Settings for the config file, which always registers the `fake` plugin. */
  config?: Record<string, unknown>;
  /** Pass --backend fake on the command line (default), or leave the backend to env and config. */
  backendFlag?: boolean;
  /** Written to the server's standard input, for --stdin. */
  stdin?: string;
}

/** Starts server.ts on a free port; with no `api` it gets one that fails the test if the model is ever called. */
export async function startHelpMe({
  args = [],
  env = {},
  api,
  config = {},
  backendFlag = true,
  stdin,
}: StartOptions = {}): Promise<HelpMe> {
  const home = mkdtempSync(join(tmpdir(), "help-me-test-"));
  const configFile = join(home, "config.json");
  writeFileSync(configFile, JSON.stringify({ ...config, plugins: { fake: FAKE_PLUGIN } }));
  const child: ChildProcess = spawn(
    process.execPath,
    [SERVER, "--no-open", "--port", "0", ...(backendFlag ? ["--backend", "fake"] : []), ...args],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PROMPT_SHAPER_CONFIG: configFile,
        FAKE_MODEL_URL: api?.url ?? "http://127.0.0.1:9",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin?.end(stdin ?? "");
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  const exited = new Promise<{ code: number | null; stdout: string }>(resolve => {
    child.on("exit", code => {
      resolve({ code, stdout });
    });
  });
  const url = await new Promise<string>((resolve, reject) => {
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      const m = /open (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stderr);
      if (m?.[1]) {
        resolve(m[1]);
      }
    });
    void exited.then(({ code }) => {
      reject(new Error(`server exited ${String(code)} before listening:\n${stderr}`));
    });
  });
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    url,
    get: path => fetch(new URL(path, url)),
    post,
    ask: async (path, body, schema) => schema.parse(await (await post(path, body)).json()),
    exited,
    stop: () => {
      child.kill();
    },
  };
}

/**
 * Runs server.ts when it is expected to exit on its own before listening. A server that starts listening instead is
 * killed after `waitMs` and reported with code null.
 */
export function runHelpMe(
  args: Array<string>,
  env: Record<string, string> = {},
  waitMs = 3000,
): Promise<{ code: number | null; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "help-me-test-"));
  const child = spawn(process.execPath, [SERVER, "--no-open", "--port", "0", ...args], {
    env: { PATH: "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const timer = setTimeout(() => child.kill(), waitMs);
  return new Promise(resolve => {
    child.on("exit", code => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}
