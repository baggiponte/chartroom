# prompt-shaper

`/help-me` for Claude Code: shape a vague request by clicking on it, then hand it back to Claude.

![/help-me demo: flipping underlined phrases, Explain me, the open questions modal, dragging a number, then Enter](docs/demo.gif)

`/help-me I want to choose a coffee machine` opens a page with your request on it. Haiku underlines every
part you could change. Click one to flip it, or drag a blue value left or right. "Explain me" shows
the options in plain words. Things you haven't said yet, like budget, wait behind an **open questions** button.
Press **Enter** and the shaped request goes back to Claude, a bit like
[plannotator](https://github.com/backnotprop/plannotator) does for plans:

```
Help me choose a bean-to-cup machine for my small kitchen, something good for lattes.

- Budget: up to €850
- Milk: a manual steam wand
```

Model calls go through the `claude` CLI, so they use your Claude Code login. No API key is needed.

## Install

You need Node 18+ and the `claude` CLI on your PATH.

```bash
git clone https://github.com/baggiponte/prompt-shaper
cd prompt-shaper
bash install-command.sh      # adds /help-me to every session
# or: claude --plugin-dir .  # loads it as a plugin, which gives /prompt-shaper:help-me
```

To try the UI without Claude, open `index.html` in a browser. It runs a demo with canned suggestions.

## Usage

```
/help-me plan a relaxed weekend in Lisbon for me and my partner in March, not too expensive
```

| | |
|---|---|
| Click an underline | pick an option, or "Something else" (Alt+↓ opens the one at the caret) |
| Drag a blue value | change a number or amount (arrow keys work too) |
| Explain me | show what each option means and who it suits, with pictures when they help |
| open questions | answer what the request doesn't say yet. **+ More questions** asks for more |
| Type | edit freely. Haiku reads the text again and keeps what you set |
| Enter / Shift+Enter / ✕ | send / new line / cancel and send nothing |

## How it works

```
/help-me <request> ─► Claude runs: node server.mjs --stdin     (blocks until you press Enter)
                         │  serves index.html on 127.0.0.1:<random>, opens the browser
browser ─ POST /api/analyze ─► claude -p --model haiku …  ─► {summary, underlines[], extras[]}
browser ─ POST /api/explain ─► claude -p --model haiku …  ─► {intro, options[{what, good_for, image?}]}
browser ─ GET commons.wikimedia.org  (picture search, no key; no picture if it fails)
browser ─ POST /api/submit  ─► server prints the request to stdout, exit 0  (cancel: exit 2)
```

| flag / env | default | |
|---|---|---|
| `--model` / `PROMPT_SHAPER_MODEL` | `haiku` | model for the analysis |
| `PROMPT_SHAPER_EFFORT` | `low` | effort level for the analysis |
| `--port` / `PROMPT_SHAPER_PORT` | random | fixed port, e.g. for SSH forwarding |
| `--no-open`, `PROMPT_SHAPER_BROWSER` | system opener | don't open a browser, or pick which one |
| `--no-images` / `PROMPT_SHAPER_IMAGES=0` | on | skip the Wikimedia Commons pictures |

## Notes

- The first read takes about 4 to 9 s, and an explanation about 3 s. Most of that is `claude -p` starting up.
- Pictures come from a plain Commons search, so they're sometimes off. Hover one for its source page.
- The command waits for you for up to 10 minutes. If it times out, run `/help-me` again.
- This is a prototype.
