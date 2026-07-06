# Session Log — 2026-06-11 — Confluence + OneDrive write surfaces (Phase 4 tail)

## What Was Done
- Added item-level write surfaces (bidirectional-sync.md §3.2) to the two document/file connectors — no board mirror for either (BaseConnector defaults kept for `listRemoteBoards`/`fetchBoardSnapshot`).
- **Confluence** (`capabilities.write = ['update_item','comment','close_item']`):
  - `update_item` — GET `/wiki/api/v2/pages/{id}?body-format=storage` to read the current `version.number` (and preserve unpatched title/body), then PUT with `version.number + 1` (optimistic locking; stale 409 surfaces as an error/conflict). `remoteVersion` = new version number as string.
  - `comment` — POST `/wiki/api/v2/pages/{id}/footer-comments` with storage-format body; `remoteVersion` stays null (comments don't bump page version).
  - `close_item` — archive via the same read-then-PUT with `status:'archived'` + version bump.
- **OneDrive** (`capabilities.write = ['update_item','move_item']`), Microsoft Graph:
  - `update_item` (rename only — `patch.title` required) — `PATCH /v1.0/me/drive/items/{id} { name }`.
  - `move_item` — `PATCH ... { parentReference: { id: toStatusRemoteId } }`.
  - `envelope.baseVersion` (eTag) rides along as `If-Match` when present; 412 surfaces as an error. `remoteVersion` = response eTag.
- Both throw `UnsupportedMutationError` for any other kind; Confluence also fails loudly on missing `baseUrl`.
- New tests (mocked global fetch, zero network): 8 Confluence + 7 OneDrive.

## Decisions Made
- Confluence `update_item` fetches with `body-format=storage` so a title-only patch preserves the existing body (the v2 PUT requires both).
- OneDrive `update_item` without `patch.title` is a hard error — files have no body/labels surface in Graph PATCH semantics we support.
- Mutation HTTP failures (incl. 409/412) are thrown, not swallowed, so the outbox worker sees conflicts; read paths keep their existing soft-fail style.

## Files Created or Modified
- `packages/integrations/src/connectors/confluence.ts` (modified — +write surface)
- `packages/integrations/src/connectors/onedrive.ts` (modified — +write surface)
- `packages/integrations/src/connectors/confluence.test.ts` (new)
- `packages/integrations/src/connectors/onedrive.test.ts` (new)

## Verification
- `pnpm --filter @pm-os/integrations typecheck` — clean.
- New tests 15/15 green; full integrations suite 132/132 green (12 files).

## Open Questions
- Confluence archiving uses PUT `status:'archived'` per the design row; Atlassian also ships a dedicated bulk-archive endpoint if this ever needs space-admin semantics.
- `fetchRemoteVersion` (cheap conflict probe) not implemented for either connector — both have natural version tokens (Confluence `version.number`, OneDrive `eTag`) if Phase 5 hardening wants it.

## Next Session Should Start With
- Wire these capability sets into the outbox/push-worker routing if not already kind-agnostic; then Phase 4 eval items per PROGRESS.md.
