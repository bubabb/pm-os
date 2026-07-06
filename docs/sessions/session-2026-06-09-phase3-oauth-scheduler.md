# Session Log — 2026-06-09 — Phase 3 Tasks 6 & 7 (Real OAuth + Background Sync)

This session implemented the final two Phase 3 tasks. With these, the Phase 3 task
list is code-complete (pending Mac `tsc` + tests on all uncommitted Phase 3 work).

## Task 6 — Real OAuth (GitHub + Microsoft Entra)

**Goal:** replace the Phase 1 dev-user sign-in stub with a real browser-window
OAuth authorization-code flow.

### Files
- **NEW** `apps/desktop/src/main/auth/oauth-service.ts`
  - `getOAuthConfig(provider)` — builds provider config from env vars; returns `null`
    when client id/secret are missing (→ caller falls back to dev stub).
  - `performOAuthFlow(provider, cfg)` — runs the full flow:
    1. Opens a modal `BrowserWindow` at the provider authorize URL with a random `state`.
    2. Intercepts navigation to the loopback redirect URI in-process via
       `will-redirect` / `will-navigate` (no HTTP listener needed); `preventDefault()`s it.
    3. Validates `state` (CSRF), extracts `code`.
    4. Exchanges `code` for an access token at the provider token endpoint (client_secret).
    5. Fetches profile — GitHub `/user` (+ `/user/emails` for a verified primary email);
       Microsoft Graph `/me`.
  - Window-closed / provider-error / state-mismatch all reject cleanly; single-settle guard.
- **MODIFIED** `apps/desktop/src/main/auth/auth-service.ts` — added `upsertOAuthUser(profile)`
  (upsert by email; refreshes name/avatar on each sign-in; role `admin`).
- **MODIFIED** `apps/desktop/src/main/auth/index.ts` — export `upsertOAuthUser`,
  `getOAuthConfig`, `performOAuthFlow`, and the `OAuthProvider`/`OAuthProfile` types.
- **MODIFIED** `apps/desktop/src/main/routes/auth.ts` — `POST /auth/sign-in` now uses real
  OAuth when configured, else the dev stub. On OAuth error returns 401 with the message.
  Sign-in event payload records `method: 'oauth' | 'dev-stub'`. `user` annotated `User`.

### Configuration (env vars — never committed)
```
PMOS_GITHUB_CLIENT_ID, PMOS_GITHUB_CLIENT_SECRET
PMOS_ENTRA_CLIENT_ID,  PMOS_ENTRA_CLIENT_SECRET,  PMOS_ENTRA_TENANT_ID (default: common)
PMOS_OAUTH_REDIRECT_URI (default: http://localhost:4321/auth/oauth/callback)
```
The redirect URI **must exactly match** the one registered on each provider's OAuth app.
No renderer or DB changes were needed — `SignIn.tsx` and the auth store already call
`POST /auth/sign-in`; the flow now opens a real provider window instead of returning a stub.

## Task 7 — Background Sync Scheduler

**Goal:** periodically sync all projects' integrations from the Electron main process.

### Files
- **NEW** `apps/desktop/src/main/scheduler/sync-scheduler.ts`
  - `startSyncScheduler()` / `stopSyncScheduler()` — `setInterval` loop.
  - Interval from `PMOS_SYNC_INTERVAL_MS` (default 15 min; `0` disables).
  - `runSyncCycle()` (exported for tests): selects non-archived projects, loads each
    project's credentials, **skips expired tokens** (`isTokenExpired`), builds
    `{credential, token}` pairs, calls `triggerSync`. Per-project try/catch isolates
    failures; a module-level `cycleRunning` flag prevents overlapping cycles.
  - Emits one `integration.sync.scheduled` **system** event per cycle (actorId
    `sync-scheduler`) when ≥1 credential synced. Per-credential started/completed/failed
    events still come from the sync engine.
- **MODIFIED** `apps/desktop/src/main/index.ts` — `startSyncScheduler()` after
  `startServer()` in `whenReady`; `stopSyncScheduler()` in `window-all-closed`.

## Verification
- **tsc / vitest NOT run** — this is the Kali syncthing peer (no `node_modules`/pnpm;
  installing here would clobber the Mac's native modules, see syncthing memory).
- Self-review performed: all cross-package and barrel imports confirmed to exist
  (`triggerSync`, `getIntegrationToken`/`isTokenExpired`, `generateId`, `User`);
  `events` `projectId`/`resourceId`/`actorId` confirmed nullable; OAuth event-handler
  types are inferred from the Electron listener signatures (no reliance on a global
  `Electron.Event`); `actorType: 'system'` is a valid enum value.

## Next Session MUST Do (on the Mac)
1. `pnpm -r exec tsc --noEmit` across the repo — fixes any type errors from this session
   **and** the still-uncommitted Domain 2 + Phase 3 review-fix work.
2. Run vitest.
3. Commit all uncommitted Phase 3 work together → **Phase 3 complete**.
4. Register GitHub OAuth App + Entra app registration; set env vars to exercise real
   sign-in end-to-end (until then, the dev-stub fallback keeps the app usable).
