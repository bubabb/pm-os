# Session Log — 2026-06-11 — Production lifecycle + DB robustness fixes (deepreview blockers)

## What Was Done
- `apps/desktop/src/main/index.ts`:
  - Added single-instance lock at bootstrap top (`app.requestSingleInstanceLock()`); losing instance quits, winner gets a `second-instance` handler that restores/focuses the existing window.
  - Fixed macOS lifecycle bug: `window-all-closed` no longer tears down push-worker/scheduler/server — on darwin services stay alive (so `activate` reopens a window against a live backend); non-darwin quits as before.
  - Service teardown moved to a `before-quit` handler via `stopServices()` guarded by a `servicesStopped` flag (stops exactly once; `event.preventDefault()` holds the quit until async teardown finishes, then re-quits).
  - Boot crash-safety: `whenReady` bootstrap body wrapped in try/catch; on failure `dialog.showErrorBox('Pm.Os failed to start', message)` + `app.quit()`.
  - Start order preserved: migrations → server → scheduler → push-worker → window.
- `packages/database/src/client.ts`:
  - Added `busy_timeout = 5000` pragma (after existing WAL + foreign_keys).
  - Added startup `integrity_check` (simple) — `console.error` loud warning on failure, no crash.
  - `runMigrations()` now also probes `process.resourcesPath`-based candidates (`migrations`, `app.asar.unpacked/migrations`) for packaged builds; `resourcesPath` accessed via a typed-optional cast so the package typechecks under plain Node; dev paths unchanged.

## Decisions Made
- `before-quit` uses preventDefault + flag + re-quit (standard Electron pattern) so async `stopSyncScheduler()`/`stopServer()` complete before process exit.
- `process.resourcesPath` typed as `NodeJS.Process & { resourcesPath?: string }` instead of pulling Electron types into @pm-os/database.

## Files Created or Modified
- /home/sudosu/projects/pm-os/apps/desktop/src/main/index.ts
- /home/sudosu/projects/pm-os/packages/database/src/client.ts

## Open Questions
- Packaged-build (electron-builder/Forge extraResources) config still needs to actually ship the migrations folder; runMigrations now resolves it once shipped.

## Next Session Should Start With
- Verify packaged build ships migrations via extraResources; run full gate (lint/unit/E2E) before merging `feat/claude-cli-membership-provider`.
