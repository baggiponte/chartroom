# Writing a backend plugin

Read this when the user wants help-me to run on something it doesn't ship with (the built-ins are `claude`, `codex`,
`gemini`, `antigravity`, `opencode`, `pi`, `anthropic`, `openai`), or wants a built-in called differently. A plugin
is one module the user's config file names; nothing in help-me changes.

## Steps

1. **Capture a real answer first.** Find the target's one-shot mode (a headless CLI flag, or an HTTP endpoint), run
   it by hand once with a tiny prompt that asks for JSON, and keep the exact stdout or response body. Parse that, not
   what the docs say it prints: CLIs add banners, progress lines and event streams.
2. **Write the module** next to the config file that help-me's error names (by default
   `~/.config/prompt-shaper/<name>.ts`), starting from the template below.
3. **Register it** in that config file. Add `"backend": "<name>"` only if the user wants it as their default; if the
   plugin is for the harness they work in, give it `host` and leave `backend` unset, so `host` picks it there.

   ```json
   { "plugins": { "<name>": "./<name>.ts" } }
   ```

4. **Call it once** without the page, from the config file's folder, and check you get `{ data: { n: ... } }`:

   ```sh
   node -e '
   const p = (await import("./<name>.ts")).default;
   const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
   console.log(await p.run({ system: "Answer with n = 2.", schema, input: "go", model: p.model ?? "",
     effort: "low", env: process.env, signal: AbortSignal.timeout(60000) }));'
   ```

5. Run help-me with `--backend <name>` and make one edit on the page; a wrong reply shape shows up there as an error.

## Template (a CLI)

````ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const onPath = (cmd, env) => (env.PATH ?? "").split(delimiter).some(d => d && existsSync(join(d, cmd)));

export default {
  model: "", // "" lets the CLI use its own default
  needs: "the mycli CLI on PATH",
  available: env => onPath("mycli", env),
  // Only for a harness: a variable it sets for the commands it runs (see Pitfalls).
  host: { agent: "My CLI", running: env => Boolean(env.MYCLI_SESSION) },
  run: ({ system, schema, input, model, env, signal }) =>
    new Promise((resolve, reject) => {
      const prompt = `${system}\n\nReply with one JSON object only, matching this JSON Schema:\n${JSON.stringify(schema)}`;
      const args = ["--print", "--no-tools", ...(model ? ["--model", model] : []), prompt];
      const child = spawn("mycli", args, { cwd: tmpdir(), env: { ...env, PROMPT_SHAPER_CHILD: "1" }, signal });
      let out = "";
      let err = "";
      child.stdout.on("data", d => (out += d));
      child.stderr.on("data", d => (err += d));
      child.on("error", reject);
      child.on("close", code => {
        const text = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(out)?.[1] ?? out;
        try {
          resolve({ data: JSON.parse(text) });
        } catch {
          reject(new Error(`mycli exited ${code}: ${(err || out).slice(0, 400)}`));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }),
};
````

For an HTTP API the README's Ollama example is the template: `fetch` with `signal`, a JSON-schema response format
if the API has one.

## The contract

| Field                   | Required | Meaning                                                                        |
| ----------------------- | -------- | ------------------------------------------------------------------------------ |
| `run(call)`             | yes      | Answer one question; resolve `{ data, model?, ms? }` or throw                  |
| `model`                 | no       | Default when the user gave no `--model`                                        |
| `available(env)`        | no       | `false` stops help-me at start with an error built from `needs`                |
| `needs`                 | no       | What is missing when `available` says no, e.g. `"MY_API_KEY"`                  |
| `host.agent`, `running` | no       | Name on the page, and whether help-me is running inside this harness right now |

`call` has `system`, `schema` (JSON Schema of the answer), `input`, `model` (already resolved), `effort` (`low`,
`medium` or `high`), `env` and `signal`. `data` is checked against `schema`; extra keys are dropped, missing ones fail.

## Pitfalls

- **Node strips the types and runs the file**, so `.ts` may only use erasable syntax: no `enum`, `namespace` or
  constructor parameter properties. `import type { Plugin } from "<skill dir>/plugins.ts"` plus `satisfies Plugin`
  gives types without a runtime import. Don't import anything else from the skill folder: its path changes when the
  plugin updates. No npm packages unless they're installed next to the module.
- **Pass `signal` to `spawn` or `fetch`.** Every edit on the page aborts the previous question; a plugin that ignores
  it leaves one CLI process running per keystroke.
- **Set `PROMPT_SHAPER_CHILD=1` on a child harness**, or a CLI that loads skills can open the help-me page again.
- **Keep the call one-off and harmless**: a temp `cwd`, no tools or read-only sandbox, no saved session. The
  question is about text; it must not touch the user's files or fill their session history.
- **No schema flag?** Put the schema in the prompt (as the template does) and parse JSON out of a code fence. No
  system prompt flag? Prepend `system` to the prompt.
- **Throw with the backend's own message** (stderr, the API's error body). It is shown on the page. Never return a
  made-up answer and never switch to another model or backend when the asked one fails: help-me must fail where the
  user can see why.
- **`available` runs at start, synchronously, for the chosen backend**: check PATH or an env var; don't spawn or
  fetch.
- **`host.running` must test a variable the harness sets for the commands it runs**, not one users set themselves
  (`CODEX_HOME` is user config; `CODEX_THREAD_ID` is the harness). With `backend: "host"`, help-me imports every
  configured plugin to ask it, so a module that fails to load stops help-me even when it isn't the host.
- **Return `model` only when the backend reports the real one**, and `ms` only when it reports its own duration.
- **Pass `model` through verbatim**, in the target's own form (`provider/model` for some CLIs), and omit the flag
  when it's `""`.

## Making it a built-in

For a pull request to help-me rather than a user's config: move the module to `providers/<name>.ts` and use
`providers/run.ts` (`runCli` already handles `signal`, `PROMPT_SHAPER_CHILD`, the temp `cwd` and a CLI that exits
before reading stdin; `timed` fills `ms`; `onPath` handles Windows extensions) and `withSchema` / `parseFenced` from
`schema.ts`. Then add it to `PROVIDERS` in `providers.ts` (harnesses before the API backends, since `host` asks them
in order), a fake-CLI test in `test/providers.test.ts` that prints the stdout you captured in step 1, a row in the
README's backend table, and the name in SKILL.md's `compatibility` and overrides table.
