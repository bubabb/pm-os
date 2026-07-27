The user is wrapping up work ("done for the day"). Persist enough state that ANY agent — next
session, another machine — can resume cleanly. Do NOT auto-commit or push unless the user
explicitly asks; saving state is about written records, not git.

Three files, three jobs. **A given fact lives in exactly ONE of them** — that rule is what keeps
this from becoming four copies of the same session written with different headers:

| File | Answers | Lifecycle |
|---|---|---|
| `PROGRESS.md` | Where does this project stand **right now**? | Overwritten — always current |
| `OPEN.md` | What loops are **still open**, per item? | Ledger — items deleted as they close |
| `docs/sessions/session-<date>-<slug>.md` | What happened **on that day**? | Append-only, never rewritten |

Step 0 — Am I in a PROJECT, or just working LOOSE?
- PROJECT = the cwd (or its git root) contains an `agent-state/` dir, a `PROGRESS.md`/`ROADMAP.md`,
  or lives under `~/projects/<name>/`. Otherwise you are working LOOSE (e.g. in `$HOME`, a scratch
  dir, or a repo with no project-tracking convention).
- In a PROJECT → Steps 1-6. Working LOOSE → Step L instead (do NOT invent a project root or a
  PROGRESS.md where there is no project).

═══ PROJECT wrap-up (Steps 1-6) ═══

Step 1 — Identify the project and USE ITS EXISTING CONVENTION.
- Determine the project root (cwd / git repo root) and its name.
- If the project already tracks work some way — an `agent-state/` dir, a `docs/sessions/` log, its
  own `save-methodology.md` — use THAT. **Do not invent a parallel structure.** Adding a new store
  beside a working one is how a project ends up with four accounts of the same day and no single
  place to look.

Step 2 — Update `PROGRESS.md`, WITH THE CURRENT STATE AT THE TOP.
- **The first `## ` heading in the file is what gets injected into the next session's context**
  (`~/.claude/hooks/session-resume.sh` reads from the top of the file, up to 4,000 chars). So the
  newest state must be the FIRST `## ` section. Push older blocks down; never append current state
  to the bottom.
  - This is not stylistic. Until 2026-07-27 the hook matched on heading *wording*, and pm-os spent
    weeks injecting a June-era block telling every new session to resume work on an Electron
    desktop launcher that had been deleted. Position is now the contract.
  - A project that needs a different section can put `<!-- RESUME-SECTION -->` on the line above it.
- Record, with an ABSOLUTE date (e.g. 2026-07-27), never "today":
  - STATUS NOW: what works, what's broken, what is unverified or uncommitted.
  - BLOCKERS / CONSTRAINTS: what would trip up the next agent (builds only on machine X, etc.).
- Keep it CURRENT, not append-only. The day-by-day narrative belongs in `docs/sessions/`.

Step 3 — Update `OPEN.md` — the per-item ledger (create it if absent).
- **Close what closed:** delete every item finished this session. An item that is still listed is
  still open; that is the file's only invariant.
- **Add what opened**, one line each: `- [YYYY-MM-DD] what is open → the exact next action`.
- Per ITEM, never per day: a project routinely has several loops open at once, opened and closing
  on different days. A per-day "needs follow-up? yes/no" flag on a day mixing one closed and three
  open items can never honestly flip to "no", so it stays "yes" forever and the injected set grows
  without bound. Per-item entries close individually.
- This file is injected WHOLE at session start (3,000 chars). Keep it terse and keep it true.

Step 4 — Write the session log in `docs/sessions/`.
- `session-YYYY-MM-DD-<short-topic-slug>.md`. This is the append-only record of the day; it is
  never rewritten, and the session-resume hook injects only its FILENAME, never its content.
- Content: what was done (file-level where it matters) · decisions and their rationale · files
  created or modified · anything unresolved. If something is unresolved, it also belongs in
  `OPEN.md` — the log records it, the ledger tracks it.
- Diagnoses get tagged **VERIFIED / ASSUMED / COULD NOT VERIFY**. A mechanism is a claim: never
  write *why* something happened without citing the command run or the file read. Never put a
  hypothesis in a commit message — commit messages are immutable, this file is not.

Step 5 — Update auto-memory as the POINTER.
- Update the project's memory file in the auto-memory dir with a one-line status and the ABSOLUTE
  path to `PROGRESS.md`, so a later "let's work on project XYZ" finds where it lives and where to
  pick up. Convert relative dates to absolute.
- Update the `MEMORY.md` index line to match. **Format (ONE line):**
  `- [Title](file.md) — one-line status · RESUME: <path>`
- MEMORY.md loads into EVERY session — it is a pointer, not a copy. Operational detail (params,
  credentials, commit hashes, file lists) lives in the memory file and `PROGRESS.md`, NEVER in the
  index line. Pointers that grow into paragraphs are how the index became 3,430 bytes of noise.

Step 6 — Report to the user.
- 3-5 lines: what was saved and where, what you CLOSED in `OPEN.md`, and the single next step on
  resume. If there is uncommitted git work, say so and where — but do not commit unless asked.

═══ LOOSE wrap-up (Step L — not in a project) ═══

Step L — Write the day's global memory file.
- Path: `~/Claude Memory/global/YYYY-MM-DD-<hostname>.md` — one file per day per machine.
  Append to it if it already exists; do not start a second file for the same day and host.
  - The `<hostname>` suffix is required, not decorative. `~/Claude Memory` is a send-receive
    Syncthing folder shared with the Mac. A single shared dated file that both machines append to
    silently loses one side's appends whenever the replicas have not converged.
- Shape — exactly this, because the session-resume hook injects today's and yesterday's files:
  ```
  ---
  date: YYYY-MM-DD
  host: <hostname>
  scope: global
  ---
  ## Done
  - <what actually changed or was decided; file-level where it matters>

  ## Follow-up needed?
  <Yes | No>

  ## Next steps        ← omit this section entirely when the answer above is "No"
  1. <the exact next action>
  ```
- If a fact is DURABLE rather than a day's events — a credential location, a system config change,
  an external resource, a standing preference — ALSO write or update a topic file in the auto-memory
  dir with a one-line `MEMORY.md` pointer. One fact per file; check for an existing file to update
  before creating a new one; don't duplicate what a repo or git history already records.
- If the work was THROWAWAY (a one-off question, a quick edit, nothing that outlives the session),
  persist NOTHING. Do not manufacture a day file to have something to show.
- Report to the user: 3-5 lines — what was done, what was saved and where, the next step if any.
