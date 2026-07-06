# Session Log — 2026-07-06 — Deepreview round 3: mirror redesign + LOWs + third review

Branch: `deepreview-fixes-2026-07-06`. Final gate: typecheck 23/23 · lint 12/12 · **tests 300/300**.

## What Was Done
- Implemented the mirror create/edit data-loss redesign properly (the piece reverted in round 2), on a design that structurally avoids the two prior failure modes.
- Fixed the two remaining LOWs (IPv6 `[::1]` loopback in CORS; `typeof body.name === 'string'` guard on `PATCH /users/me`).
- Ran a **third deepreview** (2 adversarial reviewers on the mirror rework + connector baselines) and fixed the one real MEDIUM it surfaced.

## Mirror redesign (replaces the reverted deferred-op attempt)
Design that can't deadlock and doesn't guess the hash:
1. **Baseline hash from the connector** — `create_item` returns `createdBaseline {title,statusRemoteId,state,archived}` computed the same way each connector's pull snapshot computes `contentHash`; `linkCreatedItem` stamps `lastSyncedHash` from it. Fixes the forever-revert (F1). Jira reads the created issue's real initial status; GitHub draft → `state:'draft'`; Notion → open/null.
2. **No deferred ops** — enqueue helpers still return null with no live link. `enqueuePostCreateDivergence` runs only AFTER the link exists and enqueues normal live-link ops for any local edit made while the create was in flight. A terminally-failed create leaves the card local-only and does NOT stall the credential's queue (F2 gone).
3. **Idempotency** — the create result is persisted before `status:'applied'`; a retry re-links instead of re-creating.
4. **local_wins** re-pushes the full local delta (move + forced title/body + forced close/reopen), capability-gated (skips `reopen_item` on Jira/Confluence with a warn).

### Third-review verdict (2 adversarial reviewers, grounded)
- **F1 CONFIRMED-FIXED**, **F2 CONFIRMED-FIXED** (deadlock gone; a failed create no longer blocks younger ops — proven by test).
- **Fixed this round (MEDIUM):** `local_wins` dropped a local close/reopen for *push-side* conflicts (the `remote !== null` guard skipped the state op when the conflict snapshot is `{version}`-only) → local close reverted on next pull. Now re-asserts local state even when remote is unknown; regression test added.
- **Accepted as bounded churn (documented, not data loss):** for boards where the platform auto-assigns a status on create (Notion Status property; a GitHub "set Status on add" workflow) or when Jira's post-create status read-back fails, the first pull emits ONE redundant `remoteUpdate` that re-stamps the hash and **converges** (protected by active ops; the divergence step pushes the user's real column). Reducing this churn would need a per-connector post-create item re-fetch — tracked as a follow-up, NOT correctness-critical.
- **LOW, inherent/pre-existing (documented):** mint-then-persist duplicate window if the local persist write fails mid-create (C2); crash between `applied` and `linkCreatedItem` → orphan+dup (C3, unchanged from `main`).

## Everything fixed & review-clean in the branch
Security: CORS exact-origin (+`[::1]`), dev-stub gate (Electron defaults it on), `PATCH /users/me` whitelist (+null-name guard), orphan-secrets guard, 422 passthrough, port validation, SIGINT, CLI perms. Renderer: circular-import boot crash (browser-verified), SSE re-auth probe, CONNECTING guard. Connectors: Jira full pagination + truncation warn, 4xx-throws, GitHub status-field read/write split, JQL backslash, classifier. DB: enum alignment, cost transaction, completedToday fallback, cost rounding. Mirror: create data-loss (F1/F2 fixed), idempotency, local_wins, pull ORDER BY, scheduler teardown.

## Files / verification
- Final diff vs `main`: ~36 files (see `git diff --name-only main`). Gate GREEN. Renderer boot re-verified in headless Chromium earlier this session (no renderer change since).

## Next Session Should Start With
- Optional polish: per-connector post-create item re-fetch to remove the first-pull churn on auto-status boards (C1/C2/C3 above) — quality, not correctness.
- Consider moving `linkCreatedItem` ahead of the `applied` write to close the C3 orphan-on-crash window.
- Live end-to-end round-trips (GitHub/Jira/Notion create→edit→pull) once real tenants are available.
