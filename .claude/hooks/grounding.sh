#!/usr/bin/env bash
# ALWAYS-ON: inject this project's grounding & pace contract on every prompt.
# Carried IN the project so it fires on any machine, regardless of global config — the same reason
# the review/save hooks live here. Takes precedence over ~/.claude/grounding-methodology.md, whose
# hook stands down when this file exists, so the text is injected exactly once.
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$DIR/.claude/grounding-methodology.md" ] || exit 0
jq -n --rawfile ctx "$DIR/.claude/grounding-methodology.md" \
  '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}' 2>/dev/null || true
