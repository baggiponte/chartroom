---
name: help-me
description: Opens a browser page where the user shapes a vague request by clicking on it, then returns the sharpened request. Use when the user types /help-me or asks to refine their request in the browser before you start.
compatibility: Needs Node 22.18+, a local browser, and one analysis backend (the claude, codex, gemini, agy, qwen, opencode or pi CLI, or ANTHROPIC_API_KEY / OPENAI_API_KEY).
allowed-tools: Bash(node:*)
metadata:
  version: "0.4.0"
---

# help-me

The user shapes their request in a browser page; you get the sharpened request back.

## 1. Run the page

`SKILL_DIR` is the absolute path of this SKILL.md's folder. Pass the request (the text after `/help-me`, or
their message) on stdin with a quoted heredoc:

```bash
node "SKILL_DIR/server.ts" --stdin --agent "<your name, e.g. Codex>" [override flags] <<'HELP_ME_EOF'
<the user's request, verbatim, minus any overrides (see below)>
HELP_ME_EOF
```

- Run it in the foreground with a long timeout (10 minutes, or your shell tool's max). It blocks until the user
  sends or cancels.
- It binds a port on 127.0.0.1 and opens a browser, so run it outside any sandbox that blocks that.
- If your shell tool can't wait that long, run it in the background with `--out /tmp/help-me-$$.json` and poll
  until that file exists. It holds `{"status": "sent" | "cancelled" | "timeout", "prompt": "..."}`.
- Don't pass settings the user didn't ask for: their defaults come from a config file and env vars.

### Overrides in the request

Turn instructions about the page itself into flags and **remove them from the request** on stdin:

| The user says something like                                  | Flag                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "use gemini", "with codex", "via claude", "use my OpenAI key" | `--backend gemini` (or `claude`, `codex`, `antigravity`, `qwen`, `opencode`, `pi`, `anthropic`, `openai`) |
| "with sonnet", "use gpt-5"                                    | `--model <name>` (with `--backend` if the model implies one)                                              |
| "think harder", "high effort"                                 | `--effort high`                                                                                           |
| "no pictures", "without images" / "with pictures"             | `--no-images` / `--images`                                                                                |
| "don't open the browser", "I'm on SSH"                        | `--no-open` (then give them the URL from the logs)                                                        |
| "on port 8080"                                                | `--port 8080`                                                                                             |

Only strip what is clearly about the page: "Help me choose between Gemini and Claude" is the request. If the
chosen backend isn't set up, say so and offer another.

stderr lines starting with `[prompt-shaper]` are logs; one has the page URL to give the user if no browser opened.

## 2. Use the result

- Exit 0 (`sent`): stdout is the refined request. Treat it as the user's message, every detail a firm
  constraint, and don't comment on the page.
- Exit 2 (`cancelled`): say so in one line and stop.
- Exit 3 (`timeout`) or any other error: say so briefly and offer to run it again.
