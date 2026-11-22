#!/usr/bin/env node
// prompt-shaper: serves index.html, blocks until Send, prints the shaped request on stdout.
// Exit codes: 0 sent, 2 cancelled, 3 timeout. Flags and settings: see README.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { platform } from "node:os";
import { text as readAll } from "node:stream/consumers";

import { type ExitCode, createHandler, printed } from "./api.ts";
import { createJobs, createModel } from "./model.ts";
import { type Settings, outPath, readSettings } from "./settings.ts";

const STATUS = { 0: "sent", 1: "error", 2: "cancelled", 3: "timeout" } as const satisfies Record<ExitCode, string>;

const log = (...m: unknown[]): void => {
  console.error("[prompt-shaper]", ...m);
};
const argv = process.argv.slice(2);
const env = process.env;

function writeOut(out: string, code: ExitCode, prompt: string): void {
  if (!out) {
    return;
  }
  try {
    // write then rename, so a poller never reads half a file
    writeFileSync(`${out}.tmp`, JSON.stringify({ status: STATUS[code], prompt }) + "\n");
    renameSync(`${out}.tmp`, out);
  } catch (e) {
    log(`could not write ${out}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Refusing to start still writes --out, so an agent polling it learns at once instead of at its own timeout.
const settings = ((): Settings => {
  try {
    return readSettings(argv, env);
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    writeOut(outPath(argv, env), 1, "");
    return process.exit(1);
  }
})();

const draft = settings.stdin ? (await readAll(process.stdin)).trim() : settings.draft;

// Read once, so a running server never serves a page newer than its own code. The page carries a hash of the
// file it was cut from and /api/init returns this process's, so a page that outlived its server can tell.
const source = readFileSync(new URL("index.html", import.meta.url), "utf8");
const build = createHash("sha256").update(source).digest("hex").slice(0, 12);

const jobs = createJobs();
let finished = false;
function finish(code: ExitCode, prompt: string): void {
  if (finished) {
    return;
  }
  finished = true;
  jobs.abortAll();
  process.stdout.write(printed(prompt));
  writeOut(settings.out, code, prompt);
  setTimeout(() => process.exit(code), 150);
}

const { backend, model, effort, images, agent } = settings;
const server = http.createServer(
  createHandler({
    model: createModel({ backend, model, effort, env, jobs }),
    init: { draft, model: model || backend, backend, agent, images, build },
    page: source.replace('"%BUILD%"', JSON.stringify(build)),
    log,
    finish,
  }),
);

if (settings.timeoutMin > 0) {
  setTimeout(() => {
    log(`no answer after ${String(settings.timeoutMin)} min, giving up`);
    finish(3, "");
  }, settings.timeoutMin * 60000).unref();
}

server.listen(settings.port, "127.0.0.1", () => {
  const address = server.address();
  const url = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : settings.port)}/`;
  log(`open ${url}  (waiting for Send; Ctrl+C to abort)`);
  log(
    `backend: ${backend}${model ? ` (${model})` : ""}${images ? "" : ", no pictures"}${settings.configured ? `, defaults from ${settings.configFile}` : ""}`,
  );
  if (!settings.open) {
    return;
  }
  const cmd = settings.browser || (platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open");
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // no browser to open: the URL is in the log above
  }
});
