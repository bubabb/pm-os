# Open items — pm-os

Per-ITEM open loops, injected whole at session start by `session-resume.sh` (budget 2000 chars).
**Delete an item when it closes** — this is a ledger, not a log. History lives in `docs/sessions/`,
current state in `PROGRESS.md`. Format: `- [opened] what is open → the exact next action`

## Open
- [2026-07-27] **`PROGRESS.md` carries a misleading stale section.** `## RESUME HERE` at line 412 is
  an Electron-era block telling the next agent to install a desktop icon and launch via `pnpm dev`.
  Electron was **deleted 2026-07-06** (`## STATUS NOW`, line 13) and the only run mode is now
  `pnpm pm-os` → http://127.0.0.1:4321. Until 2026-07-27 the session-resume hook injected exactly
  that block at every session start. The hook is fixed (it now reads from the top of the file), but
  the stale section is still in the file → delete or relabel it.

## Nothing else open

No. As of 2026-07-06 the rename (Creare → Pm.Os) and the whole-project deepreview remediation are
both merged to `main`, gate GREEN — typecheck 23/23 · lint 12/12 · unit 311/311. Nothing under
`## STATUS NOW` is flagged TODO / open / deferred. The `## BLOCKERS / CONSTRAINTS` section is
environmental guidance (pnpm on Kali, the automatic better-sqlite3 ABI swap), not open work.
