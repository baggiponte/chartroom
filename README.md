# prompt-shaper

![/help-me demo: flipping underlined phrases, Explain me, the open questions modal, dragging a number, then Enter](docs/demo.gif)

`/help-me` for Claude Code. Type `/help-me I want to choose a coffee machine` and a page opens in your browser
with your request on it. A small model (Haiku) reads it in the background and puts a dotted underline under
every part you could flip: *coffee machine*, *small kitchen*, *good for lattes*. Click one and a popover
offers suggestions as chips (pick one, or pick any when options can coexist), a slider for amounts, or
"Something else". Picking an option rewrites your sentence in place. Things the request doesn't mention yet,
like budget, sit behind an "open questions" button under it: a modal lists them as numbered questions with
radio buttons (pick one) or checkboxes (pick any), each with "Something else", and "+ More questions" asks for
more. Answered ones show up as small tokens under the request; click one to change it. Jargon-heavy choices get an "Explain me" link that widens
the popover into a panel under your request: one card per option with what it means in plain words, who it suits,
and a picture when one helps tell the options apart. Click a card to pick it; the sentence above updates as you go.

Press **Enter** and the shaped request goes back to the Claude Code session that opened the page, which carries
on from there, a bit like [plannotator](https://github.com/backnotprop/plannotator) does for plans:

```
Help me choose a bean-to-cup machine for my small kitchen, something good for lattes.

- Budget: up to €600
- Cups per day: 2 a day
```

All model calls go through the `claude` CLI, so they use your Claude Code login or subscription. There is no API key.

## Install

Requirements: Node 18+ and the `claude` CLI on your PATH.

```bash
git clone https://github.com/baggiponte/prompt-shaper
cd prompt-shaper

# a plain /help-me command for every session (it points at this folder)
bash install-command.sh

# or load it as a plugin, which gives /prompt-shaper:help-me
claude --plugin-dir .
```

To see the UI without Claude, open `index.html` directly. It runs a demo with canned suggestions.

## Usage

```
/help-me plan a relaxed weekend in Lisbon for me and my partner in March, not too expensive
```

- Click an underline to change it. Use Esc to close the popover and Alt+↓ to open the one under the caret.
- Click **open questions** (or an answered token) for the questions modal. Esc or Enter closes it, Cmd/Ctrl+Enter sends.
- Edit the text freely. About 0.7 s after you stop typing, Haiku reads it again, and anything you've already set is kept.
- **+ More questions** in the modal asks for more, based on what you've set so far.
- Press Enter to send it back to Claude, or Shift+Enter for a new line. ✕ cancels and sends nothing.

## How it works

```
/help-me <request> ─► Claude runs: node server.mjs --stdin     (blocks until you press Enter)
                         │  serves index.html on 127.0.0.1:<random>, opens the browser
browser ─ POST /api/analyze ─► claude -p --model haiku --effort low --tools "" --json-schema …
                         │       ─► {summary, underlines[], extras[]}
browser ─ POST /api/explain ─► claude -p --model haiku …      ─► {intro, options[{what, good_for, image?}]}
browser ─ GET commons.wikimedia.org/w/api.php  (image search, no key; no picture if it fails)
browser ─ POST /api/submit  ─► server prints the request to stdout, exit 0  (cancel: exit 2)
Claude reads the output and continues
```

| env / flag | default | |
|---|---|---|
| `--model` / `PROMPT_SHAPER_MODEL` | `haiku` | model alias used for the analysis |
| `PROMPT_SHAPER_EFFORT` | `low` | effort level for the analysis |
| `--port` / `PROMPT_SHAPER_PORT` | random | fixed port, e.g. for SSH forwarding |
| `--no-open`, `PROMPT_SHAPER_BROWSER` | system opener | don't open a browser, or pick which one opens |
| `--no-images` / `PROMPT_SHAPER_IMAGES=0` | on | skip the Wikimedia Commons pictures in explanations |

## Limits

- The first read takes about 4 to 9 s and an explanation about 3 s, mostly from starting `claude -p`.
- Pictures come from a plain Wikimedia Commons search on a query Haiku writes, so they are sometimes off.
  Hover a picture for a link to its Commons page.
- The Bash call that waits for you times out after 10 minutes. If that happens, run `/help-me` again.

This is a prototype.
