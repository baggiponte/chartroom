# prompt-shaper

`/help-me` for any coding agent: shape a vague request by clicking on it, then hand it back. It's an
[Agent Skill](https://agentskills.io), so it works in Claude Code, Codex, Gemini CLI, OpenCode, Cursor and others.

![/help-me demo: flipping underlines, multiselect, dragging a number, removing a sentence, a question in the text, Explain me, Help me decide, Tidy up and ranking, then Shift+Enter](docs/demo.gif)

`/help-me I want to choose a coffee machine` opens your request in a page. A small model underlines what you
could change: click to flip it, or drag a blue value. Questions you asked in the request get a wavy underline
and a few answers to pick from. What you haven't said yet becomes a sentence with a blank
("My budget is [budget].") that you click to fill; unfilled ones are dropped. Press **Shift+Enter** and the request
goes back to your agent, like [plannotator](https://github.com/backnotprop/plannotator) does for plans:

```
Help me choose a bean-to-cup machine for my small kitchen, something good for lattes.

- Budget: up to €850
- Milk: a manual steam wand
```

The model is whichever you already have: the `claude`, `codex` or `gemini` CLI, or an API key. See [Backends](#backends).

## Install

Needs Node 22.18+ (it runs the TypeScript source directly, with nothing to build or install) and one [backend](#backends).

```bash
npx skills add baggiponte/prompt-shaper -g
```

The [skills CLI](https://github.com/vercel-labs/skills) installs it for every agent it finds (drop `-g` for
this project only, add `-a codex` to pick agents). In Claude Code it's `/help-me ...`; in Codex, `$help-me ...`;
elsewhere, ask the agent to "use help-me".

To track `main` instead, clone the repo and symlink `skills/help-me` into your agent's skills folder
(e.g. `~/.claude/skills/help-me`). Sandboxed agents such as Codex will ask before the skill starts its local
server and opens a browser: approve it.

### Inside the Claude app

The same page can show up inline in a Claude conversation (desktop and claude.ai) instead of a browser tab, as an
[MCP App](https://modelcontextprotocol.io/extensions/apps). Pressing Send posts the shaped request into the chat as your
message. Clone the repo and install the server's two dependencies (Node 22.18+):

```bash
git clone https://github.com/baggiponte/prompt-shaper && cd prompt-shaper/mcp && npm install
```

**Claude Desktop**: add it to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart the app.

```json
{ "mcpServers": { "prompt-shaper": { "command": "node", "args": ["/full/path/to/prompt-shaper/mcp/server.ts"] } } }
```

**claude.ai**: custom connectors are reached from the internet, so run `npm run http` (it listens on
`127.0.0.1:3917/mcp`), expose it with a tunnel such as `cloudflared tunnel --url http://127.0.0.1:3917`, and add
`https://<tunnel>/mcp` in Settings → Connectors → Add custom connector. The tunnel has no login: stop it when you're done.

Then ask "help me shape this: plan a weekend in Lisbon", or say "/help-me ...". The model reading your request is
still the [backend](#backends) on your machine, picked the same way. In Claude Code's terminal there's nowhere to draw
the page, so keep using the skill there.

## Usage

```
/help-me plan a relaxed weekend in Lisbon for me and my partner in March, not too expensive
```

<img src="docs/img/overview.png" alt="The request with each kind of mark labelled: a solid underline to flip, a blue value to drag, a [blank] to fill, a wavy question you asked, the send button and the Where you are timeline" width="860">

Click an underline to pick another option or write your own (Alt+↓ opens the one at the caret). Drag a blue value
left or right to change a number, or use the arrow keys. A `[blank]` is something your request didn't say: fill
it, or leave it and it's dropped when you send; **+ More questions** adds more. Type anywhere and the model reads
the text again, keeping what you set. The timeline says what to do now and **next →** jumps to the next thing
that needs you. **Shift+Enter** sends, Enter adds a line, ✕ cancels.

<img src="docs/img/underlines.gif" alt="Clicking 'coffee machine' and picking Espresso, then dragging the budget to €800" width="640">

### Questions you asked

A question in your request ("Which heating system should it have?") gets a wavy underline and concrete answers.
Picking one rewrites it as a statement.

<img src="docs/img/question.png" alt="The popover for a question you wrote: answer chips, Something else, Help me decide and Explain me" width="420"> <img src="docs/img/question-answered.png" alt="The question rewritten as 'For heating, I'd like a dual boiler.'" width="420">

### Explain me and Help me decide

**Explain me** opens every option as a card: what it means, who it suits, and a picture when one helps.
**Help me decide** asks a few questions about you and suggests a pick, marked among the options.

<img src="docs/img/explain.png" alt="Explain me: one card per milk-frothing option with what it is and who it's good for" width="420"> <img src="docs/img/decide.png" alt="Help me decide: questions about you on the left, a suggested pick and the marked option on the right" width="420">

### Tidy up and rank

Once the request runs long, **Tidy up** reorders your sentences into a short paragraph, **Must-haves** and
**Nice to have**, without changing a word; that layout is what gets sent. Drag the ⋮⋮ grip beside an item to rank
it or move it to the other list (or focus it and press ↑/↓, or Alt+Shift+↑/↓ from the caret). Ctrl/Cmd+Z undoes
moves one at a time, and **Undo tidy** puts the original back until you edit again.

<img src="docs/img/tidy.gif" alt="Tidy up splits the request into Must-haves and Nice to have, then an item is dragged to the top" width="640">

### See what was sent

After you send, the page stays open read-only: **see what was sent** shows exactly what your agent got, and what
was left out.

<img src="docs/img/sent.png" alt="The sent text in a box, with notes on unanswered questions that were left out" width="640">

## Configuration

**Defaults** go in `~/.config/prompt-shaper/config.json` (or under `$XDG_CONFIG_HOME`; `PROMPT_SHAPER_CONFIG`
points elsewhere):

```json
{ "backend": "gemini", "images": false }
```

**Per request**, just say it: `/help-me use codex, no pictures: plan a weekend in Lisbon` shapes "plan a
weekend in Lisbon" with `--backend codex --no-images`.

Flag beats env var beats config file. A config `model` is dropped when the request picks another backend.

| config key   | flag                       | env                         | default       |                                                    |
| ------------ | -------------------------- | --------------------------- | ------------- | -------------------------------------------------- |
| `backend`    | `--backend`                | `PROMPT_SHAPER_BACKEND`     | `auto`        | see [Backends](#backends)                          |
| `model`      | `--model`                  | `PROMPT_SHAPER_MODEL`       | per backend   | model for the analysis                             |
| `effort`     | `--effort`                 | `PROMPT_SHAPER_EFFORT`      | `low`         | effort level (claude, codex)                       |
| `images`     | `--images` / `--no-images` | `PROMPT_SHAPER_IMAGES=0`    | `true`        | Wikimedia Commons pictures in "Explain me"         |
| `open`       | `--no-open`                | `PROMPT_SHAPER_OPEN=0`      | `true`        | open a browser at all                              |
| `browser`    | `--browser`                | `PROMPT_SHAPER_BROWSER`     | system opener | which browser command to use                       |
| `port`       | `--port`                   | `PROMPT_SHAPER_PORT`        | random        | fixed port, e.g. for SSH forwarding                |
| `timeoutMin` | `--timeout-min`            | `PROMPT_SHAPER_TIMEOUT_MIN` | `30`          | give up (exit 3) if nobody answers                 |
|              | `--agent`                  | `PROMPT_SHAPER_AGENT`       | guessed       | agent name on the page, e.g. "Send to Codex"       |
|              | `--out FILE`               |                             |               | also write `{"status","prompt"}` to FILE when done |

For per-agent defaults, set the env vars in that agent's config (e.g. `"env"` in `~/.claude/settings.json`).

## Backends

| `--backend` | Uses                                                                                   | Default model      |
| ----------- | -------------------------------------------------------------------------------------- | ------------------ |
| `claude`    | `claude -p` with your Claude Code login                                                | `haiku`            |
| `codex`     | `codex exec` with your Codex login, JSON enforced by `--output-schema`                 | your Codex default |
| `gemini`    | `gemini -p` with your Google login                                                     | `gemini-2.5-flash` |
| `anthropic` | `ANTHROPIC_API_KEY` (and optional `ANTHROPIC_BASE_URL`)                                | `claude-haiku-5-5` |
| `openai`    | `OPENAI_API_KEY` and/or `OPENAI_BASE_URL`, so OpenRouter, Ollama or LM Studio work too | `gpt-5-mini`       |

`auto` tries the calling agent's CLI, then `claude`, `codex`, `gemini` on your PATH, then `ANTHROPIC_API_KEY`,
then `OPENAI_API_KEY`. Pick a small, fast model: every edit triggers a new read.

## Development

The skill runs straight from `skills/help-me/` with nothing to install; the dev tooling is for working on it.

- `skills/help-me/server.ts` is what `/help-me` runs: it serves the page, waits for Send and prints the request on
  stdout. `api.ts` lists the routes the page calls, `tasks.ts` and `prompts.ts` what each one asks the model,
  `providers.ts` every backend and how `auto` picks one.
- `mcp/server.ts` serves the same page as an MCP App: `node mcp/server.ts` for stdio, `--http` for `127.0.0.1:3917/mcp`.
- `page/` is the page's source. `pnpm build` bundles it into `skills/help-me/index.html`, which is committed.
- `docs/shots.ts` and `docs/rec.ts` record the README's images and GIF from demo mode.

```sh
pnpm install
pnpm build                 # after editing page/
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test
```

## Notes

- With `claude`, a read takes 4 to 9 s, mostly CLI start-up. API keys are faster.
- Pictures come from a plain Commons search, so they're sometimes off.
- Most agents wait up to 10 minutes. If it times out, run `/help-me` again.
- This is a prototype.

## Credits

Inspired by [research](https://x.com/liu_xingyu/status/2121015724374397183) from [Xingyu Liu](https://x.com/liu_xingyu).
