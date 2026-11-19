---
description: Think a request through in a browser form before Claude works on it (Haiku builds the questions)
argument-hint: [what you need help with]
allowed-tools: Bash(node:*)
---
Open the help-me page so the user can shape this request in a browser tab. Haiku underlines the parts of the
request they can flip (chips, multiselects, sliders in a popover) and adds a few tokens for things the request
doesn't mention yet, like budget.

Run exactly this with the Bash tool, in the foreground, with `timeout: 600000`. It blocks until the user
presses Enter or Send (or Cancel) in the browser:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server.mjs" --stdin <<'HELP_ME_EOF'
$ARGUMENTS
HELP_ME_EOF
```

Lines starting with `[prompt-shaper]` are logs. One of them has the URL; if the browser did not open, give the user that URL.

When the command finishes:
- Exit code 0: the rest of the output is the user's refined request, possibly followed by "- Token: value"
  lines for extra settings they picked. Treat it as the user's message and carry on with the request, using
  every setting as a firm constraint. Don't comment on the page itself.
- Exit code 2: the user cancelled. Say so in one line and stop.
- Timeout or any other error: tell the user briefly and offer to run `/help-me` again.
