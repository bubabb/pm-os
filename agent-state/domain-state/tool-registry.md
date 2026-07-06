# Domain State: Tool Registry
**Status:** Implemented (Phase 3) — tsc verification pending on Mac
**Last updated:** 2026-06-08

## Implemented
- `packages/tool-registry/src/index.ts` — full domain API (tools, versions, deployments, rollback)
- `apps/desktop/src/main/routes/tools.ts` — REST routes, registered in server.ts
- `apps/desktop/src/renderer/pages/tools/ToolsPage.tsx` — registry UI, wired into App.tsx
- CONTRACT.md bumped to v1.1 (synchronous API + actorId params)

## Invariants
- Versions immutable; `latestVersionId` = newest published (≠ deployed).
- Single active deployment per tool; rollback is additive (new deployment, never destructive).
- Every mutation emits an event with `domain: 'tool-registry'`.

## Outstanding
- Run `tsc --noEmit` for `@pm-os/tool-registry` and `@pm-os/desktop` on the Mac.
- `tool.deployment.failed` event reserved but unused (atomic local deploys).
