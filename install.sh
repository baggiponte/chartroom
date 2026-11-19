#!/usr/bin/env bash
# Links the help-me skill into the skill folders of the agents you have, so /help-me works in each.
# Prefer `npx skills add baggiponte/prompt-shaper` if you have npm; this is the no-npm way from a clone.
#   bash install.sh            # every agent below whose config folder exists
#   bash install.sh codex      # just these: claude | codex | gemini | opencode | agents
set -euo pipefail
skill="$(cd "$(dirname "$0")" && pwd)/skills/help-me"
dir_for() {
  case "$1" in
    claude) echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ;;
    codex) echo "${CODEX_HOME:-$HOME/.codex}" ;;
    gemini) echo "$HOME/.gemini" ;;
    opencode) echo "$HOME/.config/opencode" ;;
    agents) echo "$HOME/.agents" ;;  # shared folder read by Codex, Cursor, Amp and others
    *) echo "unknown agent: $1 (use claude, codex, gemini, opencode or agents)" >&2; exit 1 ;;
  esac
}
explicit=$#
[ $# -eq 0 ] && set -- claude codex gemini opencode agents
for a in "$@"; do
  base="$(dir_for "$a")"
  [ "$explicit" -eq 0 ] && [ ! -d "$base" ] && continue
  mkdir -p "$base/skills"
  ln -sfn "$skill" "$base/skills/help-me"
  echo "linked $base/skills/help-me -> $skill"
done
