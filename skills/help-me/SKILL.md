---
name: help-me
description: Opens a browser page where the user shapes a vague request by clicking on it (flip underlined phrases, drag numbers, answer open questions), then returns the sharpened request for you to work on. Use when the user types /help-me, or explicitly asks to shape, refine or pin down their request in the browser before you start.
compatibility: Needs Node 18+, a local browser, and one analysis backend (the claude, codex or gemini CLI, or ANTHROPIC_API_KEY / OPENAI_API_KEY).
allowed-tools: Bash(node:*)
metadata:
  version: "0.4.0"
---

# help-me

The user wants to shape their request in a browser page before you work on it. The page underlines the parts
of the request they can flip, and asks about what it doesn't say yet. When they press Enter, you get the
sharpened request back.

## 1. Run the page

`SKILL_DIR` below is the folder that contains this SKILL.md. Use its absolute path.

The request is what the user asked for help with: the text after `/help-me`, or their message. Pass it on
stdin with a quoted heredoc so nothing in it gets expanded:

```bash
node "SKILL_DIR/server.mjs" --stdin --agent "<your name, e.g. Codex>" [override flags] <<'HELP_ME_EOF'
<the user's request, verbatim, minus any overrides (see below)>
HELP_ME_EOF
```

- Run it in the foreground and give the command a long timeout (10 minutes, or the most your shell tool
  allows). It blocks until the user presses Enter, Send or Cancel in the browser.
- It needs to bind a port on 127.0.0.1 and open a browser, so run it outside any sandbox that blocks that,
  asking for approval if your agent needs it.
- If your shell tool cannot wait that long, start it in the background with `--out /tmp/help-me-$$.json`
  added, tell the user to finish in the browser, and check that file every few seconds until it exists. It
  then holds `{"status": "sent" | "cancelled" | "timeout", "prompt": "..."}`.
- Don't pass settings the user didn't ask for. Their defaults are already read from
  `~/.config/prompt-shaper/config.json` and `PROMPT_SHAPER_*` env vars, and without them the server picks a
  backend by itself (your own CLI first, then `claude`, `codex`, `gemini`, then API keys).

### Overrides in the request

The user can tack instructions for the page itself onto the request. Turn each into a flag and **remove it
from the request** you pass on stdin, so the page only shows what they want help with:

| The user says something like | Flag |
|---|---|
| "use gemini", "with codex", "via claude", "use my OpenAI key" | `--backend gemini` (or `claude`, `codex`, `anthropic`, `openai`) |
| "with sonnet", "use gpt-5" | `--model <name>` (with `--backend` if the model implies one) |
| "think harder", "high effort" | `--effort high` |
| "no pictures", "without images" / "with pictures" | `--no-images` / `--images` |
| "don't open the browser", "I'm on SSH" | `--no-open` (then give them the URL from the logs) |
| "on port 8080" | `--port 8080` |

Only strip what is clearly about running the page. "Help me choose between Gemini and Claude" is the
request, not an override. If the first run fails because the chosen backend is not set up, say so and offer
to run it again with another one.

Lines on stderr starting with `[prompt-shaper]` are logs. One of them has the page URL. If no browser opened
(for example over SSH), give the user that URL.

## 2. Use the result

- Exit code 0 (or status `sent`): stdout is the user's refined request, possibly followed by
  `- Token: value` lines for settings they picked. Treat it as the user's message and carry on with it,
  using every setting as a firm constraint. Don't comment on the page itself.
- Exit code 2 (or `cancelled`): the user cancelled. Say so in one line and stop.
- Exit code 3 (or `timeout`), or any other error: tell the user briefly and offer to run it again.
