The user is wrapping up work ("done for the day"). Persist the project state so
ANY agent — next session, another machine — can resume cleanly. Do NOT auto-commit
or push unless the user explicitly asks; saving state is about written records, not git.

Step 1 — Identify the project.
- Determine the current project root (cwd / git repo root) and its name.
- If the project already has a tracking convention (e.g. an agent-state/ dir,
  a session log), use THAT instead of creating a parallel one. Match the existing
  structure rather than inventing a new file.

Step 2 — Write the in-repo progress record (source of truth).
- Update (or create) `PROGRESS.md` at the project root — or the project's existing
  tracking file. Record, with an ABSOLUTE date (e.g. 2026-06-09), not "today":
  - DONE THIS SESSION: what actually changed, file-level where it matters.
  - STATUS NOW: what works, what's broken, what's unverified/uncommitted.
  - NEXT / RESUME HERE: the exact next step — files to open, commands to run,
    the decision pending. Be specific enough that a cold agent needs no guesswork.
  - BLOCKERS / CONSTRAINTS: anything that would trip up the next agent
    (build only runs on machine X, don't run Y here, etc.).
- This file is the detailed source of truth. Keep it current, not append-only noise.

Step 3 — Update auto-memory as the POINTER (so a new session finds the project).
- Update the project's memory file under the auto-memory dir with a one-line status
  AND the absolute path to the in-repo progress file, so that when the user later
  says "let's work on project XYZ" the agent knows: where it lives, current status,
  and where to pick up. Convert relative dates to absolute.
- Update the MEMORY.md index line to match.
- The auto-memory entry is a pointer, not a copy — keep it short; the repo file holds detail.

Step 4 — Report to the user.
- Give a 3–5 line summary: what was saved, where (both paths), and the single
  next step on resume. If there is uncommitted git work, say so and where — but
  do not commit unless asked.
