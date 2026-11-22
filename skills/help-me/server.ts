#!/usr/bin/env node
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { platform } from "node:os";
import { text as readAll } from "node:stream/consumers";

import { type ExitCode, errorMessage, printed } from "./api.ts";
import { createHandler } from "./http.ts";
import { createJobs } from "./jobs.ts";
import { createModel } from "./model.ts";
import { readPage } from "./page.ts";
import { type Settings, outPath, readSettings } from "./settings.ts";

const STATUS = { 0: "sent", 1: "error", 2: "cancelled", 3: "timeout" } as const satisfies Record<ExitCode, string>;

const log = (...m: Array<unknown>): void => {
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
    log(`could not write ${out}: ${errorMessage(e)}`);
  }
}

// Refusing to start still writes --out, so an agent polling it learns at once instead of at its own timeout.
const settings = ((): Settings => {
  try {
    return readSettings(argv, env);
  } catch (e) {
    log(errorMessage(e));
    writeOut(outPath(argv, env), 1, "");
    return process.exit(1);
  }
})();

const draft = settings.stdin ? (await readAll(process.stdin)).trim() : settings.draft;

const page = readPage();

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
    init: { draft, model: model || backend, backend, agent, images, build: page.build },
    page: page.html,
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
    // the URL is in the log above
  }
});
