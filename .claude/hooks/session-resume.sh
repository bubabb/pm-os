#!/usr/bin/env bash
# SessionStart hook (Claude Code): inject the project's resume state at session start —
# current git branch/status + the CURRENT-STATE section of PROGRESS.md (or ROADMAP.md), the
# open-items ledger, and pointers to the latest session logs — so a fresh session begins
# grounded without the user having to ask. Runs every session: keep it FAST.
# Emits JSON additionalContext; exits 0 silently when there's nothing to say.
#
# 2026-07-27 — SECTION SELECTION REWRITTEN. The old rule was:
#     awk '/^## +(RESUME|Status)/{p=1;print;next} /^## /{if(p)exit} p{print}' | head -c 3000
# It had three defects, each verified against real files:
#   1. Case-sensitive: pm-os's '## STATUS NOW' (line 12, the CURRENT state) never matched, so it
#      fell through to '## RESUME HERE' at line 412 — a June-era block instructing the agent to
#      resume work on the Electron desktop launcher that was DELETED 2026-07-06.
#   2. Wrong section even when it matched: scout's '## RESUME HERE' is self-labelled
#      '2026-07-24 VINTAGE, PARTLY STALE' and is superseded by '## ⇢ START HERE' at line 9,
#      which the regex could never reach.
#   3. head -c truncated mid-word (scout's stale section is 26,132 chars; 3,000 of it is 11%).
# The rule is now POSITIONAL, not vocabulary-based: take the TOP of the file from its first '## '
# heading. Verified correct for all five projects with a PROGRESS.md — scout (line 9), pm-os (12),
# scout-demo (9), devops_platform (12), _template (9). Heading wording has ALREADY drifted per
# project ('⇢ START HERE' / 'STATUS NOW' / 'RESUME HERE'); any rule that chases wording drifts
# again. A project needing to override can put a <!-- RESUME-SECTION --> marker above its heading.
set -uo pipefail
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
out=""

# Budgets (chars). Truncation is always at a LINE boundary, never mid-word, and always says so.
# OPEN_BUDGET is the largest of the three on purpose: a LEDGER that truncates has failed at its one
# job (scout's real ledger is 2,563 chars and lost its "verification owed" item at 2000). It is also
# the only one that is self-limiting — items are deleted as they close, so it does not grow with
# time the way an append-only log does. PROGRESS and the global day files ARE logs, so truncating
# them with a "read the file" pointer is the correct trade.
#
# 2026-07-30 — REBALANCED DOWN (4000/3000 -> 3000/2200). These budgets were set when the hook was
# believed to deliver everything it emitted. It does not: above ~10KB the harness injects only a
# ~2KB preview (measured). With the standing-preference files now carried in full, the old budgets
# pushed the total past the cap and the preferences — the one section that must never be missed —
# were what got cut. Priority order under pressure: preferences > memory DB > PROGRESS > OPEN.
PROGRESS_BUDGET=2000
OPEN_BUDGET=2600
GLOBAL_BUDGET=500

# Trim stdin to a budget on a line boundary; append a pointer when anything was dropped.
# $1 = budget, $2 = where to look for the rest.
trim() {
  local budget="$1" src="$2" body kept
  body=$(cat)
  if [ "${#body}" -le "$budget" ]; then printf '%s' "$body"; return; fi
  kept=$(printf '%s' "$body" | head -c "$budget" | sed '$d')
  printf '%s\n\n[…truncated at %s chars — read %s for the rest]' "$kept" "$budget" "$src"
}

# Git state: branch + uncommitted count. Scope the count to THIS directory (pathspec '.'), not
# the whole repo — the project may be a subdirectory of a larger repo (e.g. one rooted at $HOME),
# which would otherwise report that repo's branch and an inflated, unrelated change count.
if git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  br=$(git -C "$DIR" branch --show-current 2>/dev/null)
  [ -z "$br" ] && br=$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo 'no commits yet')
  n=$(git -C "$DIR" status --porcelain . 2>/dev/null | grep -c . || true)
  top=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$top" ] && [ "$top" != "$DIR" ]; then
    out="Git: branch '${br}' (enclosing repo ${top}, not this project dir), ${n} uncommitted change(s) under ${DIR}."
  else
    out="Git: branch '${br}', ${n} uncommitted change(s)."
  fi
fi

# Resume file: prefer a REAL PROGRESS.md, else ROADMAP.md. Skip a placeholder PROGRESS.md (the
# template ships one with '<what works' scaffold text) so a fresh in-template session doesn't inject it.
rf=""
[ -f "$DIR/PROGRESS.md" ] && ! grep -qF '<the exact next step' "$DIR/PROGRESS.md" 2>/dev/null && rf="$DIR/PROGRESS.md"
[ -z "$rf" ] && [ -f "$DIR/ROADMAP.md" ] && rf="$DIR/ROADMAP.md"

# Nothing here? Then this session was opened somewhere with no project — usually $HOME, which is
# how this operator actually works: one Claude session, several projects underneath it. Without
# this, a session that opens with "last session was interrupted" starts by HUNTING for which
# project that was (find | sort by mtime), which is a slow, guessy way to begin.
#
# So: point at the most recently touched project under ~/projects and say so plainly. It is a
# heuristic — it is labelled as one, and it never overrides a real PROGRESS.md in the actual dir.
#
# GATED ON $HOME SPECIFICALLY, not merely on "no PROGRESS.md here". This file is copied into each
# project's .claude/hooks/, and _template ships a PLACEHOLDER PROGRESS.md that the guard above
# rejects — so an ungated heuristic would leave rf empty in a _template session and then inject
# whichever OTHER project was touched most recently. Same for any scratch dir. Verified 2026-07-27.
active=""
if [ -z "$rf" ] && [ "$DIR" = "$HOME" ] && [ -d "$HOME/projects" ]; then
  rf=$(find "$HOME/projects" -maxdepth 2 -name PROGRESS.md -not -path '*/.*' -printf '%T@ %p\n' \
       2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  [ -n "$rf" ] && active="yes"
fi

if [ -n "$rf" ]; then
  proj=$(dirname "$rf")
  if [ -n "$active" ]; then
    out="${out}${out:+$'\n'}No project at ${DIR}. MOST RECENTLY TOUCHED project (last modified $(date -r "$rf" '+%Y-%m-%d %H:%M')): ${proj}
This is a guess from file mtime, not a declaration — confirm it is the one the user means before acting on it."
  fi

  # --- Current-state section ---------------------------------------------------------------
  # Precedence: explicit <!-- RESUME-SECTION --> marker, else the file's FIRST '## ' section
  # onwards. Both stop at the budget, on a line boundary.
  if grep -qF '<!-- RESUME-SECTION -->' "$rf" 2>/dev/null; then
    sec=$(awk '/<!-- RESUME-SECTION -->/{p=1;next} p' "$rf" 2>/dev/null | trim "$PROGRESS_BUDGET" "$rf")
    how="marked section"
  else
    sec=$(awk '/^## /{p=1} p' "$rf" 2>/dev/null | trim "$PROGRESS_BUDGET" "$rf")
    how="top of file"
  fi
  [ -z "$sec" ] && { sec=$(head -40 "$rf"); how="first 40 lines (no '## ' heading found)"; }
  out="${out}${out:+$'\n'}Resume file: ${rf} — read it first. Current state (${how}):
${sec}"

  # --- Open-items ledger -------------------------------------------------------------------
  # Per-ITEM open loops, not per-day flags: a project routinely has several open at once, so a
  # per-day yes/no can never honestly close. Injected whole (it is meant to stay short).
  if [ -f "$proj/OPEN.md" ]; then
    open=$(trim "$OPEN_BUDGET" "$proj/OPEN.md" < "$proj/OPEN.md")
    out="${out}
Open items (${proj}/OPEN.md):
${open}"
  fi

  # --- Session-log pointers ----------------------------------------------------------------
  # Names only, never content: these average ~5KB each. The point is that the agent KNOWS the
  # recent log exists and can open it, not that it is copied into every session's context.
  # Sort by FILENAME (they are session-YYYY-MM-DD-*.md), never by mtime: these files arrive via
  # Syncthing, which rewrites mtimes — pm-os's 42 logs all carry near-identical mtimes, so `ls -t`
  # reported session-2026-06-02 as the newest when the real newest is session-2026-07-06.
  if [ -d "$proj/docs/sessions" ]; then
    logs=$(ls -1 "$proj/docs/sessions"/*.md 2>/dev/null | sort -r | head -3 | sed 's/^/  - /')
    [ -n "$logs" ] && out="${out}
Latest session logs (read if you need what happened recently):
${logs}"
  fi
fi

# --- Global tier -----------------------------------------------------------------------------
# Work not tied to a project. Fixed path (NOT the harness auto-memory dir, which is keyed by
# launch cwd and would move if the user ever launched elsewhere). The <hostname> suffix is
# deliberate: ~/Claude Memory is a send-receive Syncthing folder shared with the Mac, and a
# single shared YYYY-MM-DD.md that both machines append to on the same date is a conflict
# generator — non-converged replicas silently lose one side's appends. Per-host files remove
# that collision class entirely; the reader globs the date and takes whatever hosts exist.
GLOBAL_DIR="$HOME/Claude Memory/global"
if [ -d "$GLOBAL_DIR" ]; then
  today=$(date +%F); yday=$(date -d yesterday +%F 2>/dev/null || echo "$today")
  gfiles=$(ls -1 "$GLOBAL_DIR/$today"-*.md "$GLOBAL_DIR/$yday"-*.md 2>/dev/null | head -4)
  if [ -n "$gfiles" ]; then
    gbody=$(echo "$gfiles" | tr '\n' '\0' | xargs -0 cat 2>/dev/null | trim "$GLOBAL_BUDGET" "$GLOBAL_DIR")
    [ -n "$gbody" ] && out="${out}${out:+$'\n'}Global memory (non-project work, ${GLOBAL_DIR}):
${gbody}"
  fi
fi

# --- Memory database — ADDITIVE, and it must never break a session start -----------------------
# Everything above comes from FILES. This adds what files cannot answer: delegations never closed,
# agent runs that ended unresolved and what they said was missing, findings still ASSUMED rather
# than VERIFIED, and which other projects exist.
#
# BOUNDED ON PURPOSE. `timeout` caps the whole call and MEMORY_RECALL_TIMEOUT caps each query, so a
# paused free-tier instance costs a few seconds once — never a hung session start. memory-recall.py
# exits 0 in every failure path and prints a LOUD banner rather than silence, because a store that
# is unreachable must not read as a store that is empty.
if [ -x "$DIR/scripts/memory-recall.py" ] && command -v python3 >/dev/null 2>&1; then
  mdb=$(MEMORY_RECALL_TIMEOUT=4 MEMORY_RECALL_CAP=${MEMORY_RECALL_CAP:-1200} timeout 7 python3 "$DIR/scripts/memory-recall.py" 2>/dev/null)
  if [ -n "$mdb" ]; then out="${out}${out:+$'\n\n'}${mdb}"
  else
    out="${out}${out:+$'\n\n'}## Memory

**⚠ MEMORY RECALL PRODUCED NOTHING** (timed out, or python3/psql is unavailable). This session has
NOT read the memory database — open delegations and unresolved agent runs are not shown and must
not be assumed absent. Diagnose with \`make memory-status\`."
  fi
fi

# --- Launched at \$HOME while projects exist? Say so, loudly. ----------------------------------
# VERIFIED 2026-07-30: a project's autoMemoryDirectory is honoured ONLY when the launch cwd is
# exactly the directory holding .claude/settings.json — not a parent, not a subdirectory, and a git
# root does not extend it. So a session started at \$HOME gets GLOBAL memory even while editing a
# project's files. That is correct behaviour (spec: \$HOME work is global work), but it is silent,
# and silence here looks exactly like "this project has no memory".
if [ "$DIR" = "$HOME" ] && [ -d "$HOME/projects" ]; then
  regd=$(find "$HOME/projects" -maxdepth 2 -name .project-id -not -path '*/.*' 2>/dev/null | head -5)
  if [ -n "$regd" ]; then
    out="${out}${out:+$'\n\n'}## Memory scope — GLOBAL, not project

This session launched at \`$HOME\`, so **no project's memory database is loaded** — project memory
resolves from the LAUNCH directory only. Work done here belongs to the global store.

**To work on a project with its memory, restart from inside it:** \`cd ~/projects/<name> && claude\`.
Registered projects: $(printf '%s' "$regd" | sed "s|$HOME/projects/||; s|/.project-id||" | tr '\n' ' ')"
  fi
fi

# --- Durable memory store — UNCONDITIONAL ----------------------------------------------------
# Every topic file, injected WHOLE, every session. Deliberate: the previous design auto-loaded only
# MEMORY.md and left the rest to be opened on demand — so recall depended on the agent DECIDING to
# open a file, which is precisely where it failed. If a file is in this folder it is in context.
#   - Depth 1 only, so archive/ is excluded by construction.
#   - MEMORY.md is SKIPPED: the harness loads it already; injecting it here would duplicate it.
#   - Fixed path, not the launch-cwd-keyed auto-memory dir, so the same memory loads from anywhere.
#   - -print0/read -d '' throughout: the path contains a space ("Claude Memory").
# MEM_CAP is a runaway guard, not a budget — ~3x current usage (35,923 B on 2026-07-27), and it
# ANNOUNCES itself rather than silently dropping files, because a silent drop is the failure mode
# this whole change exists to remove.
# TWO TIERS, because injecting all 14 files whole (~36KB) put the section far past the ~10KB the
# harness actually delivers — so it reached NOTHING. Measured 2026-07-30; see the HARD TOTAL CAP
# note below for the numbers. The old code's promise ("auto-loaded in full") was unachievable.
#
#   FULL TEXT  — feedback_* and user_*: the standing preferences and who the user is. Short
#                (2,185 B for all three) and the ones that must never be missed, because an
#                unloaded preference is silently violated rather than noticed.
#   INDEX ONLY — everything else (project_*, reference_*): one line each, name + the frontmatter
#                `description:`. Enough to know the file exists and is worth opening.
#
# This is a deliberate trade the owner chose: always-on full text for the few, discoverability for
# the rest. It is honest about which is which — a file listed under INDEX has NOT been read.
MEM_DIR="$HOME/Claude Memory/-home-sudosu/memory"
if [ -d "$MEM_DIR" ]; then
  full=$(find "$MEM_DIR" -maxdepth 1 \( -name 'feedback_*.md' -o -name 'user_*.md' \) -print0 2>/dev/null \
         | sort -z | while IFS= read -r -d '' f; do printf '\n──── %s ────\n' "$(basename "$f")"; \
              awk 'NR==1&&/^---[[:space:]]*$/{fm=1;next} fm&&/^---[[:space:]]*$/{fm=0;next} !fm' "$f"; done)
  idx=$(find "$MEM_DIR" -maxdepth 1 -name '*.md' ! -name 'MEMORY.md' \
             ! -name 'feedback_*.md' ! -name 'user_*.md' -print0 2>/dev/null \
        | sort -z | while IFS= read -r -d '' f; do
            d=$(sed -n 's/^description:[[:space:]]*//p' "$f" | head -1 | sed 's/^"//; s/"$//')
            printf '  - %s — %.60s\n' "$(basename "$f")" "${d:-(no description)}"
          done)
  [ -n "$full" ] && out="${out}${out:+$'\n'}Standing preferences and user profile (full text — ${MEM_DIR}):${full}"
  [ -n "$idx" ] && out="${out}${out:+$'\n'}Other memory files — NOT read, open one if relevant (${MEM_DIR}):
${idx}"
fi

[ -z "$out" ] && exit 0

# --- HARD TOTAL CAP — the harness truncates, and it does so SILENTLY -------------------------
# MEASURED 2026-07-30 with unguessable tokens at known offsets in a scratch project:
#     9,081 chars  -> fully injected (token at offset 0 AND at the end both retrievable)
#    12,088 chars  -> only a ~2KB PREVIEW is injected; the rest is written to a file the model
#                     is told about but cannot read, so it silently vanishes from context.
# This session's own start proves it: "Output too large (49.4KB). Preview (first 2KB)".
#
# CONSEQUENCE, and it is severe: this hook has been emitting ~50KB, so EVERYTHING past roughly
# the first 2KB — the open-items ledger, session-log pointers, and the entire "Durable memory
# store" dump below — has NOT been reaching sessions, while the code above claims "if a file is
# in this folder it is in context". That claim was false in practice.
#
# So the cap is enforced HERE, once, over the whole payload, and it ANNOUNCES what it dropped.
# A loud truncation is recoverable; a silent one is how a session confidently proceeds on a
# quarter of its state.
HOOK_CAP=${HOOK_CAP:-8400}
if [ "${#out}" -gt "$HOOK_CAP" ]; then
  kept=$(printf '%s' "$out" | head -c "$HOOK_CAP" | sed '$d')
  out="${kept}

[!! SESSION-START CONTEXT TRUNCATED at ${HOOK_CAP} of ${#out} chars — content below this point was
DROPPED, not summarised. The harness injects only a ~2KB preview above ~10KB, so this cap exists to
keep what fits deterministic and to tell you what did not. What is usually cut, in order: the tail
of the open-items ledger, session-log pointers, and the memory store (${MEM_DIR:-n/a}).
Read those files directly if this session depends on them.]"
fi

# SessionStart accepts plain stdout as context too, so fall back if jq is missing.
command -v jq >/dev/null 2>&1 || { printf '%s\n' "$out"; exit 0; }
jq -n --arg ctx "$out" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
