# Session Log — 2026-06-11 — Connector-agnostic board mirror + conflict resolution backend

## What Was Done
- **Job 1 — generalized the board mirror** so any connector can provide it:
  - `connectors/base.ts`: added read-only defaults `listRemoteBoards(): Promise<RemoteBoardOption[]>` (returns `[]`) and `fetchBoardSnapshot(remoteBoardId): Promise<MirrorBoardSnapshot>` (throws `"<source> does not support board mirroring"`).
  - `connectors/github.ts`: marked `listRemoteBoards` as `override`; added `override fetchBoardSnapshot` delegating to `GitHubProjectsClient.fetchProjectSnapshot`.
  - `sync-engine.ts`: exported `buildConnector(source, config)` (behavior unchanged) — the single source→connector construction.
  - `mirror/mirror-sync.ts`: `createMirror`/`pullMirror` now build the connector from `credential.source` via `buildConnector` + a `ConnectorConfig` (token + baseUrl/metadata from the credential) and call `connector.fetchBoardSnapshot(...)` — no direct `GitHubProjectsClient` usage remains. Added `listRemoteBoards(source, config)` for the routes layer's import picker.
- **Job 2 — conflict resolution backend** (`mirror/conflicts.ts`, NEW):
  - `listOpenConflicts(projectId, boardId?)` — open `sync_conflicts` joined to `remote_links`, optionally scoped to one mirrored board (credentialId + containerRemoteId, same scoping as `getMirrorStatus`), rendered as `ConflictView` with human `itemTitle`/`localSummary`/`remoteSummary` (local vs remote column names).
  - `resolveConflict(conflictId, resolution, getCredential)`:
    - `dismiss` → resolution `'dismissed'`, cancels parked failed/conflicted ops (clears the divergence signal).
    - `remote_wins` → applies the stored remote item snapshot via a single-item `boards.applyMirrorSnapshot` (column move + task update + `lastSyncedHash` = remote hash), cancels pending/failed/conflicted ops.
    - `local_wins` → re-enqueues a fresh `move_item` via `outbox.enqueueBoardItemMove` from the item's CURRENT column (push happens via the outbox drain), then cancels the old parked ops (fresh op shielded by opId).
    - Emits `integration.conflict.resolved` events; unknown/already-resolved ids throw clear Errors.
- `index.ts`: exported `listRemoteBoards`, `listOpenConflicts`, `resolveConflict`, `ConflictView`, `ConflictResolution`, `buildConnector`; marked the `GitHubConnector` export as a deprecated escape hatch (the mirrors route still imports it).
- Added `mirror/conflicts.test.ts` (6 tests: human view + board filter, all three resolutions end-to-end incl. clean re-pull after remote_wins, clear-error cases).

## Decisions Made
- `remote_wins` applies the **stored** remote snapshot (offline-capable) rather than re-fetching; push-side conflicts (which only store `{version}`) throw a clear "pull the mirror and resolve the refreshed conflict" error.
- Single-item `MirrorApply` includes ONLY the target column described by its current local shape — an empty `columns` list would dump the item in the board's first column (applyMirrorSnapshot fallback).
- `getCredential` is accepted (route wiring parity with `drainMutationQueue`) but unused in Phase 1 (`_getCredential`) — no resolution talks to the remote directly.
- Kept the `GitHubConnector` export so `apps/desktop/src/main/routes/mirrors.ts` keeps compiling; the route should migrate to `listRemoteBoards(source, config)`.

## Files Created or Modified
- `packages/integrations/src/connectors/base.ts` (modified)
- `packages/integrations/src/connectors/github.ts` (modified)
- `packages/integrations/src/sync-engine.ts` (modified — export only)
- `packages/integrations/src/mirror/mirror-sync.ts` (modified)
- `packages/integrations/src/mirror/conflicts.ts` (NEW)
- `packages/integrations/src/mirror/conflicts.test.ts` (NEW)
- `packages/integrations/src/index.ts` (modified)

## Verification
- `pnpm --filter @creare/integrations typecheck` — green.
- `pnpm vitest run packages/integrations/src/mirror` — 40/40 (4 files, 6 new).
- `pnpm --filter @creare/integrations lint` — clean.

## Open Questions
- The mirrors route (`apps/desktop/src/main/routes/mirrors.ts`, Domain: desktop) still constructs `GitHubConnector` directly for the picker — migrate it to `listRemoteBoards`/`listOpenConflicts`/`resolveConflict` and then drop the deprecated export.
- `local_wins` whose fresh enqueue parks as 'failed' still marks the conflict resolved; the next pull re-detects the divergence (intended, but worth a UI hint).

## Next Session Should Start With
Wire the routes layer: replace the direct `GitHubConnector` picker call with `listRemoteBoards`, and add HTTP endpoints for `listOpenConflicts` / `resolveConflict` (conflict-resolution UI is the Phase 2 design item).
