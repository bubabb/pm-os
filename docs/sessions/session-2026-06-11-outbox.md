# Session Log — 2026-06-11 — Durable push outbox (mirror/outbox.ts)

## What Was Done
- Implemented `packages/integrations/src/mirror/outbox.ts` (NEW): `enqueueMutation`, `enqueueBoardItemMove`, `drainMutationQueue` per docs/architecture/bidirectional-sync.md (push §).
- Implemented `packages/integrations/src/mirror/outbox.test.ts` (NEW): 10 tests, all network-free (GitHubConnector mocked, in-memory DB via @pm-os/database/testing).
- Verified: `pnpm --filter @pm-os/integrations typecheck` green, `pnpm vitest run packages/integrations/src/mirror/outbox.test.ts` 10/10, package lint green, full integrations suite 59/59.

## Decisions Made
- **statusFieldRemoteId storage convention:** `board_column` remote_links rows store the Status FIELD remote id in `containerRemoteId` (an option's container IS its field); `board_item` links store the ProjectV2 node id in `containerRemoteId`. mirror-sync / boards.applyMirrorSnapshot MUST write column links with `containerRemoteId = snapshot.statusFieldRemoteId`. This makes move_item ops self-contained — no metadata refetch at drain time.
- Conflict status string is `'conflicted'` (matches schema comment + reconciler), event type is `integration.mutation.conflict` (per task spec).
- FIFO tiebreak: `ORDER BY created_at ASC, rowid ASC` (UUIDs are v4, not time-ordered).
- Single-flight: module-level `drainingCredentials` set (overlapping drain calls skip busy credentials) + pending→in_flight claim guarded by `changes === 0` skip.
- On a transient failure the credential's drain loop BREAKS (op left pending) so retries happen before younger ops — preserves FIFO causality. Terminal failures (failed/conflicted) continue draining.
- Fatal (no-retry) errors: UnsupportedMutationError, GitHubScopeError, GitHubNotFoundError, plain `HTTP 401/403` messages, unparseable payload. Everything else transient, max 5 attempts.
- move_item is LWW: version drift does NOT conflict; pushed anyway with `overwroteRemote: true` in the applied event payload.
- `enqueueBoardItemMove` returns null only when the ITEM has no live link (board not mirrored); a mirrored item moving to an unlinked column (or links violating the containerRemoteId convention) THROWS at enqueue time — mirror-integrity errors surface immediately instead of failing on every drain.

## Files Created or Modified
- packages/integrations/src/mirror/outbox.ts (new)
- packages/integrations/src/mirror/outbox.test.ts (new)

## Open Questions
- mirror-sync.ts (createMirror/pullMirror) and boards.applyMirrorSnapshot must honor the column-link containerRemoteId convention above — not yet written/aligned.
- outbox.ts exports are not yet re-exported from packages/integrations/src/index.ts (routes/push-worker will need them).

## Next Session Should Start With
- Wire `enqueueBoardItemMove` into routes/boards.ts PATCH + build sync/push-worker.ts calling `drainMutationQueue` with the secrets-layer getCredential; ensure applyMirrorSnapshot writes column links with containerRemoteId = statusFieldRemoteId.
