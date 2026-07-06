# Session Log — 2026-07-06 — Whole-project deepreview (cross-model verified)

## What Was Done
- Ran the `deepreview` protocol (Ground → Verify → Break-it) over the **entire Creare monorepo** on `main` @ `fa66ad6` (clean tree, no working diff → review object = whole project current state).
- **Gate re-established (GREEN):** `pnpm typecheck` → 23/23 tasks; `pnpm lint` → exit 0; `pnpm test` → 293/293 across 29 files.
- Fanned out **6 domain reviewers** (auth/secrets, connectors, sync/mirror, server/headless/CLI, renderer, db/packages/build).
- Handed **11 risky candidate findings to cross-model skeptics** (session = Opus 4.8; skeptics on **Fable 5** and **Sonnet 5**) to re-derive cold. **All 11 CONFIRMED.**

## Confirmed findings (severity-ranked, all cross-model verified)

### HIGH — security
1. **Cross-origin admin-token theft on the headless server.** `server.ts:105-108` CORS uses `origin.startsWith('http://localhost'|'http://127.0.0.1')` (prefix match → `http://localhost.evil.com` passes). Combined with the default dev-stub sign-in (`oauth-service.ts:42-73` returns null with no OAuth env → `auth.ts:22-37` → `auth-service.ts:102-118` mints an **admin** JWT with no credential check), a malicious page can `fetch` `POST /auth/sign-in` cross-origin and read the admin token from the body. *Precondition:* victim runs headless with no OAuth env + visits attacker page; Chrome PNA *may* block, Firefox/Safari don't. **Fix:** exact-match origin hostname; gate dev-stub behind `CREARE_DEV_AUTH=1`.
2. **Mass-assignment on `PATCH /users/me`.** `routes/users.ts:20-24` spreads raw `request.body` into Drizzle `.set()`; no route JSON schema, no ajv `removeAdditional` anywhere in `main/`. `role`/`email`/`id` are real writable columns. Role-escalation is currently **inert** (every user minted `admin`), but **email/id rewrite is live today** (identity spoofing via email-keyed `upsertOAuthUser`; FK corruption via id). Becomes full priv-esc once roles/multi-user ship. **Fix:** whitelist `{name, avatarUrl}` or attach a schema with `additionalProperties:false`.

### HIGH — data loss / correctness
3. **Edits/closes/moves on a freshly-created mirrored card are silently dropped, then reverted.** `remote_links` is written only on create-push success (`outbox.ts:648-698`) and never sets `lastSyncedHash` (stays NULL). Until then `enqueueItemUpdate/Close/Move` return `null` (indistinguishable from "not mirrored"); routes (`mirror-cards.ts:143-165`, `boards.ts:266-268`) swallow it as `{ok:true}` with `pendingPushes=0`. Next pull: link with NULL hash + no active op → reconciler `remoteUpdate` (`reconciler.ts:124-132`) → `applyMirrorSnapshot` overwrites the local edit. The comment route *does* guard this (400 "no remote counterpart yet") — update/close/move don't. Window unbounded while create-push retries. **Fix:** chain deferred ops to the create, or fold latest state into the create payload at drain; at minimum stop returning `{ok:true}`.
4. **Jira boards >200 issues silently archive open issues.** `jira.ts:168-213` caps the board snapshot at 200 (`updated DESC`) and `fetchBoardSnapshot` returns it as *complete*, no partial flag. Missing older (still-open) issues → `reconciler.ts:138-142` `remoteDeletes` → `boards/index.ts:722-736` tombstones them; they flip-flop back as `newItems` (losing local column state) when re-updated. Mid-pagination `if(!res.ok) break` (jira.ts:187) truncates on a transient error too (Notion `throws`). Jira-specific; GitHub/Notion paginate fully. **Fix:** paginate Jira fully, or flag truncated snapshots and skip `remoteDeletes`; replace the `break` with a `throw`.

### MEDIUM
5. **Mid-session 401 → tight redirect loop.** `api.ts:41-45` clears the token but not the auth store or SSE; stale `user` bounces `SignIn ⇄ ProtectedRoute`, `/reports`→`PMCommandCenter` dashboard GET re-401s (`reporting.ts:35`). Not dampened (Zustand fetch, not TanStack Query). Low-frequency trigger (30-day JWT expiry / user-row deletion / keys loss), but SPA fully unusable until reload. **Fix:** 401 branch should call `signOut()` (reset user + `disconnectSse()`).
6. **`create_item` is not idempotent → duplicate remote cards.** `outbox.ts:584-596` marks `applied` (no own try/catch) after `applyMutation`; a `SQLITE_BUSY` on that write, or a lost response after the remote created the item, lands in the non-fatal catch (`isFatalPushError` matches only 40[13]/scope/notfound) → released to `pending` → re-push. No idempotency key sent (`github.ts:76-84`). **Fix:** persist a "remote-created, link-pending" state or send a client mutation id.
7. **`local_wins` discards title/body/close/comment edits.** `conflicts.ts:256-270` enqueues only a `move_item` for the current column and `cancelOps` the content-carrying op; `localSnapshot` is stored (`outbox.ts:732`) but **never read back**. Documented "Phase 1" limitation, but silently violates the "local wins" contract. **Fix:** re-derive and re-enqueue the local delta for `local_wins`.
8. **GitHub Projects Status-field fallback writes the wrong field.** `github-projects.ts:607-623` matches `field(name:"Status")` case-sensitively, else returns the *first* single-select. A board ordering `Priority`/`Size` before a renamed/localized status field → moves rewrite Priority. The project's own test (`github-projects.test.ts:437-463`) hard-codes this behavior. **Fix:** case-insensitive match; bail or use option-name heuristics on ambiguity.
9. **4xx recorded as a healthy 0-item sync.** jira/confluence/notion/onedrive `fetchEntities` do `if(!res.ok) return {entities:[],...}`; `base.ts:87-116` passes 400/404/410 through; `sync-engine.ts:100-129` skips purge + marks `idle`, `lastErrorMessage:null`. Only `github.ts:231-240` throws on 404 (comment proves the authors knew). A renamed Jira project / revoked Notion share serves stale data with green health. **Fix:** throw on unexpected 4xx in the other connectors.
10. **Headless boot orphans a legacy safeStorage profile.** `secrets-service.ts:66-92` / `auth-service.ts:54-100`: step-2 (blob→raw migration) requires `safeStorage`; headless `getSafeStorage()` (`electron-optional.ts:20-32`) returns null → step-3 generates a **new** master+JWT key (only a `console.error`), orphaning all ciphertext + sessions. Precondition: legacy blob-only profile never migrated, opened headless first. **Fix:** hard-stop (or env override) when `masterKeyBlob` exists but safeStorage is absent.
11. **`ModelProvider` union ≠ DB provider enum (latent).** `ai-sdk/types.ts:1` has `claude-cli` (the default, `reasoning-config.ts:14`) but DB enums (`schema.ts:80,471`) have `local` instead. No live `recordCost` caller yet; migration SQL emits plain `text` (no CHECK), so a forced write persists and mis-categorizes spend. **Fix:** unify the contract.

## Secondary tier — grounded by one reviewer, NOT cross-model verified (mostly LOW)
- Connections have no per-user ownership → IDOR if multi-user (`connections.ts`) — MEDIUM, design-dependent.
- SSE never re-auths on token expiry → silent infinite 30s reconnect (`sse.ts`) — MEDIUM, already a documented PROGRESS gap.
- `CredentialError` 422 flattened to 502 on `/connections/:id/resources` (`connections.ts:85-106`) — LOW.
- `requireRole` defined but wired to zero routes — LOW.
- Non-numeric `CREARE_PORT` → `NaN` → random port, misleading printed URL — LOW.
- SPA fallback returns 200 index.html for method-mismatch GETs with `Accept: text/html` — LOW.
- Early-SIGINT can hang if `stopServer()` rejects before listen (`headless.ts:47-51`) — LOW.
- CLI token `0600` only on create; `~/.creare` not `0700` — INFO.
- Scheduler teardown can await an instantly-resolved promise, not the in-flight cycle (`sync-scheduler.ts:151-177`) — LOW/MED.
- Pull `pendingOps` has no `ORDER BY` vs reconciler's "queue order" assumption — LOW.
- Unreachable classifier rule for unassigned tickets (`classifier.ts:39-45` vs jira JQL) — LOW.
- `jqlQuote` doesn't escape backslash (`jira.ts:417-419`) — LOW, not currently reachable.
- SSE duplicate-connection guard only covers OPEN, not CONNECTING (`sse.ts:19`) — LOW, currently unreachable.
- `signOut` store action is dead code (no renderer caller) — LOW/intent.
- `recordCost` writes cost row + event non-atomically (`cost-tracking.ts:8-24`) — LOW.
- `completedToday` filters `startedAt` not `completedAt` (`agent-activity.ts:74-76`) — LOW, day-boundary undercount.
- Per-call cost `Math.ceil` to whole cents inflates reported spend (`anthropic/openai/gemini.ts`) — LOW.
- CORS `startsWith` also flagged independently by the server reviewer (same root as finding 1).

## What's working correctly (verified solid)
- Crypto: AES-256-GCM, fresh 12-byte IV/row, no IV reuse; atomic keys write (temp+rename); fresh-install raw-key scheme portable electron↔headless.
- IDOR guards on project-scoped credential routes (integrations/secrets/conflicts two-step checks); FK-safe children-first cascade delete; token-rotation propagation.
- OAuth PKCE S256, exact redirect match, CSRF state, double-fire guard.
- Mirror crash recovery (`recoverStaleInFlight`), FIFO+backoff single-flight, atomic cache swap (skip-purge-on-empty), tombstone filtering, idempotent teardown.
- Connector retry bounded (3 attempts, honors Retry-After); GitHub GraphQL error classification; Confluence/Notion/GitHub/OneDrive pagination correct; correlator false-positive rejection.
- DB pragmas (WAL, foreign_keys, busy_timeout, integrity_check) applied once correctly; migration path resolves in dev/headless/packaged; indexes cover hot paths; no SQL injection (all bound params); model IDs current for this environment.
- Renderer focus-loss fix is real and complete across Dialog/DelegateConfigDrawer/CommandPalette; 422 correctly does NOT sign out; no dead renderer→route wiring; ErrorBoundary isolates crashes.
- Every route applies `requireAuth` (intentional exceptions: health, sign-in, me, SSE); `CREARE_SERVE_WEB` opt-in keeps the Electron path byte-identical.

## Decisions Made
- Review object = whole-project current `main` (no working diff), per the deepreview precedence rule.
- Cross-model split: generators on Opus, skeptics on Fable 5 + Sonnet 5, one skeptic per risky finding.

## Files Created or Modified
- This log only. **No code changed** — review is read-only. No fixes applied yet.

## Open Questions
- Is multi-user a live v1 scenario? Determines whether findings 2 (role side) and the connections-IDOR item are HIGH or dormant.
- Are the two HIGH data-loss bugs (3, 4) in-scope to fix now, or acceptable given current single-user / small-board usage?

## Next Session Should Start With
- Fix the two HIGH security findings first (CORS exact-match + gate dev-stub; whitelist `PATCH /users/me`) — cheap, high value.
- Then the two HIGH data-loss paths (defer-ops-until-create-links; paginate Jira mirror fully / skip deletes on truncated snapshot).
- Re-run the gate after each fix.
