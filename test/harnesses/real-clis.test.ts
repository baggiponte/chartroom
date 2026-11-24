// Runs against the real harness CLIs, installed by .github/workflows/harnesses.yaml, never on every commit. It checks
// only what needs no login and no model: chartroom finds each CLI, every flag it passes still exists in that CLI's
// --help, and the CLI still sets the env var chartroom reads to know it is running inside it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, test } from "node:test";

import { PROVIDERS, isProvider } from "../../skills/chartroom/providers.ts";
import type { ProviderName } from "../../skills/chartroom/providers.ts";
import { check } from "../../skills/chartroom/schema.ts";
import type { Schema } from "../../skills/chartroom/schema.ts";

interface Harness {
  cli: string;
  /** Where the flags of the command chartroom runs are listed. */
  help: Array<string>;
  /** A string the installed CLI holds only if it still sets chartroom's host env var for its child processes. */
  setsHostEnv?: string;
}

const HARNESSES: Partial<Record<ProviderName, Harness>> = {
  claude: { cli: "claude", help: ["--help"], setsHostEnv: "CLAUDECODE=1" },
  codex: { cli: "codex", help: ["exec", "--help"], setsHostEnv: "CODEX_THREAD_ID" },
  // agy sets no env var we know of, so chartroom never treats it as the host.
  antigravity: { cli: "agy", help: ["--help"] },
  opencode: { cli: "opencode", help: ["run", "--help"], setsHostEnv: 'process.env.OPENCODE="1"' },
  pi: { cli: "pi", help: ["--help"], setsHostEnv: 'process.env.PI_CODING_AGENT="true"' },
};

const ONLY = process.env["HARNESSES"]?.split(",").filter(Boolean);

function which(cmd: string): string | undefined {
  return (process.env["PATH"] ?? "")
    .split(delimiter)
    .map(d => join(d, cmd))
    .find(p => existsSync(p));
}

/** The argv chartroom would pass, caught by a stand-in CLI that records it and exits without calling anything. */
async function argvOf(name: ProviderName, cli: string): Promise<Array<string>> {
  const dir = mkdtempSync(join(tmpdir(), "argv-"));
  const argvFile = join(dir, "argv");
  writeFileSync(join(dir, cli), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\ncat > /dev/null\nexit 1\n`);
  chmodSync(join(dir, cli), 0o755);
  await PROVIDERS[name]
    .run({
      system: "sys",
      schema: { type: "object", properties: { n: { type: "number" } } },
      input: "in",
      model: "some-model",
      effort: "low",
      env: { PATH: `${dir}:/usr/bin:/bin` },
      signal: new AbortController().signal,
    })
    .catch(() => undefined);
  return readFileSync(argvFile, "utf8").split("\n");
}

/** Some CLIs print help or their version on stderr, so both streams count. */
function run(cmd: string, args: Array<string>): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} exited ${String(r.status)}: ${r.stderr}`);
  return r.stdout + r.stderr;
}

const isFlag = (arg: string): boolean => /^--?[a-z][\w-]*$/i.test(arg);
const listed = (help: string, flag: string): boolean =>
  new RegExp(`(^|[\\s,\\[])${flag.replaceAll("-", String.raw`\-`)}($|[\\s,=<\\[\\]])`, "m").test(help);

/** The npm package directory the CLI on PATH comes from: the nearest parent with a package.json. */
function packageRoot(bin: string): string | undefined {
  for (let dir = dirname(realpathSync(bin)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
  }
  return undefined;
}

/** Only the dependency names are read, so the versions stay unchecked. */
const PACKAGE_JSON = {
  type: "object",
  properties: { dependencies: {}, optionalDependencies: {} },
} as const satisfies Schema;

/**
 * The package and the packages it depends on, wherever npm put them: a global install nests them inside the package,
 * a lockfile install puts them next to it. Codex keeps its real binary in a platform package, so both count.
 */
function packageDirs(root: string): Array<string> {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  check(pkg, PACKAGE_JSON, join(root, "package.json"));
  const deps = [pkg.dependencies, pkg.optionalDependencies].flatMap(field =>
    typeof field === "object" && field !== null ? Object.keys(field) : [],
  );
  const found = deps.flatMap(dep => {
    for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", dep);
      if (existsSync(join(candidate, "package.json"))) {
        return [candidate];
      }
    }
    return [];
  });
  return [root, ...found];
}

function contains(dir: string, needle: Buffer): boolean {
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const file = join(dir, entry);
    if (statSync(file).isFile() && readFileSync(file).includes(needle)) {
      return true;
    }
  }
  return false;
}

for (const name of Object.keys(HARNESSES).filter(isProvider)) {
  const harness = HARNESSES[name];
  if (harness === undefined) {
    continue;
  }
  describe(name, { skip: ONLY !== undefined && !ONLY.includes(name) }, () => {
    test(`chartroom finds ${harness.cli} on PATH`, t => {
      assert.ok(PROVIDERS[name].available(process.env), `${harness.cli} is not on PATH`);
      t.diagnostic(run(harness.cli, ["--version"]).trim());
    });

    test(`every flag chartroom passes is in ${harness.cli} ${harness.help.join(" ")}`, async () => {
      const help = run(harness.cli, harness.help);
      const flags = (await argvOf(name, harness.cli)).filter(isFlag);
      assert.ok(flags.length > 0, "chartroom passed no flags");
      assert.deepEqual(
        flags.filter(f => !listed(help, f)),
        [],
        `flags missing from ${harness.cli} ${harness.help.join(" ")}`,
      );
    });

    const { setsHostEnv } = harness;
    if (setsHostEnv !== undefined) {
      test(`${harness.cli} still sets the env var chartroom looks for`, () => {
        const bin = which(harness.cli);
        const root = bin && packageRoot(bin);
        assert.ok(root, `no npm package found for ${harness.cli}`);
        const dirs = packageDirs(root);
        assert.ok(
          dirs.some(dir => contains(dir, Buffer.from(setsHostEnv))),
          `${setsHostEnv} not found under ${dirs.join(", ")}`,
        );
      });
    }
  });
}
