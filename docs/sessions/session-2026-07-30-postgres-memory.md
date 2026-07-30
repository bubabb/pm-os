# Session Log — 2026-07-30 — Postgres memory layer applied to pm-os

## What Was Done

Applied the memory layer built in `~/projects/_template`. Branch `agent/main/postgres-memory`,
2 commits, pushed, **not merged**. No application code was touched — only scripts, hooks and
`package.json` scripts.

- `.project-id` = `c3223bc3-a48c-4a7e-a029-d5353ade75e4`, database `memory_pm_os`, role
  `mem_pm_os` on the dedicated `agent-memory` Supabase instance.
- Indexed pm-os's existing records. **Counts reconciled against the files:** 6 handoffs, 1 open
  item, 42 session logs, 10 agent-log entries, 0 tasks (there is no `agent-state/tasks/`).
- `autoMemoryDirectory` → `~/Claude Memory/pm-os/memory`; a SessionStart hook
  (`.claude/hooks/session-resume.sh`, new here) and a Stop-hook spool flush.
- Five npm scripts — `memory:sync`, `memory:check`, `memory:recall`, `memory:provision`,
  `memory:status` — because this repo has no Makefile.

## Decisions Made

- **pm-os is updated by hand, not by `make sync-template`.** It has no `Makefile`,
  `.template-manifest`, `.template-version`, `.githooks` or `docs/sop`, so the propagation
  mechanism the other repos use cannot reach it. The alternative — adding all of that to a working
  pnpm/turbo workspace — is a bigger change than the memory layer warrants on its own.
  **This is documented drift:** a future fix to the memory scripts in `_template` needs the same
  hand-copy here.
- **Memory is a separate database from anything the project builds**, and isolated from other
  projects' memory by a per-project role. Verified by test in the template's session log.

## Findings — tagged

**VERIFIED — the session-start payload is bounded.** The harness replaces `additionalContext` with
a ~2KB preview above roughly 10,000 chars (9,081 arrives whole, 12,088 does not). pm-os's hook
emits **6,869** chars, comfortably inside it.

**VERIFIED — `autoMemoryDirectory` resolves from the LAUNCH directory only.** Working on pm-os with
its memory loaded means `cd ~/projects/pm-os && claude`. A session started at `$HOME` gets the
global store instead — correct behaviour, but silent, so the hook now announces it.

**Observation, not a defect:** `agent-state/` here has only `agent-log.md`, `domain-state/` and
`handoffs/` — no `tasks/` or `delegation-plans/`. The memory schema has those tables; they are
simply empty for this project.

## Files Created or Modified

New: `.project-id`, `memory/migrations/`, `.claude/hooks/session-resume.sh`,
`scripts/{project-id.sh,memory-provision.sh,memory-sync.py,memory-recall.py,memory-spool.sh}`.
Modified: `package.json` (memory scripts), `.claude/settings.json`, `.gitignore`.

## Next Session Should Start With

`OPEN.md`. Nothing here blocks pm-os work; the open items are about the memory layer itself and
live mainly in `~/projects/_template/OPEN.md`.
