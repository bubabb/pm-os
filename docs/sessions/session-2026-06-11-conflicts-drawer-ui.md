# Session Log — 2026-06-11 — Conflict-resolution UI (ConflictsDrawer + MirrorStatusChip)

## What Was Done
- Built `ConflictsDrawer.tsx` (NEW): shared `Dialog` ("Sync conflicts"), conflicts query, per-conflict resolve cards with Keep mine / Take theirs / Dismiss, loading/error/empty states.
- Modified `MirrorStatusChip.tsx`: openConflicts badge is now a button opening the drawer; added a failedPushes destructive badge (also opens the drawer); added `failedPushes` to the `SyncStatus` type; pendingPushes badge, "Pull now", and last-synced untouched.
- Verified: `pnpm --filter @pm-os/desktop typecheck` green (tsc -b --noEmit) and eslint clean on both files.

## Decisions Made
- Single `useMutation` with `{ conflictId, resolution }` variables instead of three mutations; per-card busy spinner derived from `resolve.isPending && resolve.variables.conflictId` (TanStack v5 discriminated union makes `variables` non-optional while pending). All resolve buttons disable while any resolve is in flight to keep busy tracking unambiguous.
- Conflicts query uses `enabled: open` so the drawer doesn't fetch while closed.
- Resolution-specific success toasts: kept your version / took the remote version / dismissed.
- Reused destructive-tone badge styling for failedPushes (matches conflict badge); both route to the same drawer per spec.

## Files Created or Modified
- `apps/desktop/src/renderer/pages/boards/ConflictsDrawer.tsx` (new)
- `apps/desktop/src/renderer/pages/boards/MirrorStatusChip.tsx` (modified)

## Open Questions
- Backend routes (`GET /projects/:projectId/conflicts`, `POST .../conflicts/:conflictId/resolve`, `failedPushes` on sync-status) are being built in parallel — UI is contract-complete but untested against a live server.
- Shared `Dialog` panel is `max-w-md`; the two-column comparison fits but is tight. If conflicts carry long summaries, consider a width prop on Dialog (owned elsewhere).

## Next Session Should Start With
- Wire-test the drawer against the real conflicts endpoints once the backend branch lands; confirm failed pushes actually surface as ConflictView rows.
