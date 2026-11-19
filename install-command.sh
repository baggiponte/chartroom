#!/usr/bin/env bash
# Installs a personal /help-me command (no plugin namespace) that points at this folder.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.claude/commands"
sed "s|\${CLAUDE_PLUGIN_ROOT}|$here|g" "$here/commands/help-me.md" > "$HOME/.claude/commands/help-me.md"
echo "Installed /help-me -> $HOME/.claude/commands/help-me.md (uses $here/server.mjs)"
