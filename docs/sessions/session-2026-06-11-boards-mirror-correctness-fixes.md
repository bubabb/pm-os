# Session Log — 2026-06-11 — Boards mirror-engine correctness fixes (deepreview follow-up)

## What Was Done
- Fixed 4 correctness bugs in the boards-side mirror engine (`packages/boards/src/index.ts`):
  1. **Append-only event log for mirrored task writes** — `applyMirrorSnapshot` now emits
     `task.created` (mirrored task created), `task.updated` (title/status changed by sync),
     and a per-item `board.item.removed` (mirrored item deleted) via `_logEvent`,
     domain `boards`, actorType `system`.
  2. **`_findRemoteLink` board-scoping** — optional `containerRemoteId` param; all
     `board_column` and `board_item` lookups now pass `apply.board.remoteId` (the ProjectV2
     node id), so one credential mirroring two projects with identical GitHub default
     status-option ids can no longer cross-wire columns/items onto the wrong board.
  3. **Local deletes tombstone remote links** — `removeBoardItem`, `deleteColumn`, and
     `deleteBoard` (board link + its column/item links) set `remote_links.deletedAt`
     so the next pull recreates entities instead of writing into deleted local ids.
  4. **Column-miss safety** — if a column link points at a column that no longer exists
     locally, `applyMirrorSnapshot` RECREATES the column, repoints + resurrects the link;
     items are never mapped into a dead `columnId`.
- **Database package change (required by fix 2):** `remote_links_remote_unique_idx`
  widened from `(credential_id, remote_type, remote_id)` to include `container_remote_id`.
  Without this the second project's column link insert violates the unique index — the
  cross-wire scenario was physically unrepresentable. Migration `0008_keen_naoko.sql`
  generated via `pnpm db:generate` (DROP INDEX + CREATE UNIQUE INDEX, additive-safe).
  Pull-side (integrations mirror-sync) already scoped queries by `containerRemoteId`,
  so the widened index matches the existing design intent.
- 8 new tests in `packages/boards/src/index.test.ts` (19 total, all green); full monorepo
  suite 151/151 green; boards + database + integrations typecheck green; boards lint green.
- `packages/boards/CONTRACT.md` updated: new event rows, `statusFieldRemoteId` on the
  MirrorApply board shape, and a "Remote-link guarantees" section. Bumped to v1.1.

## Decisions Made
- New mirror events use domain `boards` (not `agent-orchestration`) — consistent with every
  other event the package emits and with the writer-owns-the-event convention.
- Tombstoning uses `isNull(deletedAt)` guards so already-tombstoned links keep their
  original tombstone timestamp.
- `deleteColumn` on a column still holding items is rejected by the FK (pre-existing
  behavior, unchanged) — tests empty the column via `moveBoardItem` first.
- Column recreate path resurrects a tombstoned column link (`deletedAt: null`) and
  repoints `localId` rather than inserting a duplicate link.

## Files Created or Modified
- `packages/boards/src/index.ts` (fixes 1–4)
- `packages/boards/src/index.test.ts` (8 new tests)
- `packages/boards/CONTRACT.md` (events + guarantees, v1.1)
- `packages/database/src/schema.ts` (unique index widened — one line + comment)
- `packages/database/src/migrations/0008_keen_naoko.sql` (generated)
- `packages/database/src/migrations/meta/0008_snapshot.json`, `meta/_journal.json` (generated)

## Open Questions
- The widened unique index treats NULL `container_remote_id` as distinct (SQLite), so
  links without a container are no longer globally deduped per credential — acceptable
  today (only pv2 links use the index meaningfully) but worth a NOT NULL or CHECK later.
- `deleteBoard` does not cascade-delete the backing tasks of mirrored items (tasks are
  kept for history, matching the remote-delete path) — confirm that is the desired UX.

## Next Session Should Start With
- These changes are uncommitted on `main` (alongside pre-existing modified files in
  `apps/desktop` from the mirror Phase 1 work). Review + commit, and run the desktop E2E
  gate before shipping.
