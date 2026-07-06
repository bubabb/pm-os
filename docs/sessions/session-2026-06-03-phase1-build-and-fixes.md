# Session Log — 2026-06-03 — Phase 1 Build & Fixes

## What Was Done
- Installed pnpm globally (was missing from environment)
- Upgraded better-sqlite3 to v12.10.0 (v9.x does not build on Node 24)
- Upgraded drizzle-kit to v0.31.10 (v0.20 uses deprecated command syntax)
- Ran Drizzle migrations — all 25 tables created at ~/.pmos/pmos.db
- Built Task #4: auth-service, auth-middleware, agent-permissions, secrets-service, integration-credentials-service
- Built Task #5: Fastify server (localhost:4321), health check, CRUD routes for projects/users/secrets, SSE stream endpoint, OpenAPI docs at /docs
- Built Task #17: notification-service with SSE delivery, cost threshold trigger, approval gate trigger, notification routes
- Built Task #6: React app shell, auth flow, sidebar/topbar, project management pages, notifications panel
- Conducted full Phase 1 review — identified 9 issues (3 critical, 4 medium, 2 minor)
- Fixed all 9 issues in a single pass, TypeScript clean after all fixes

## Decisions Made
- JWT secret and AES-256 master key both persist to ~/.pmos/keys.json (safeStorage-encrypted, mode 0600). This file is shared between auth-service and secrets-service via readKeysFile/writeKeysFile helpers exported from auth-service.
- SSE endpoint accepts token via ?token= query param as fallback (EventSource cannot set headers). Standard requireAuth is NOT used on the SSE route — a dedicated resolveSseUser() handles both auth paths.
- getJwtSecret() is now exported from auth-service and used by both auth-service internally and routes/auth.ts — single source of truth for the JWT signing key.
- encryptSecret/decryptSecret sync stubs removed entirely — only the Async variants exist and are exported.
- archivedAt removed from PatchProjectBody — archive is only via DELETE (sets current timestamp server-side).
- getUnreadCount uses SQL count() aggregate — not row fetch.
- projects import in notification-service moved to static top-level.

## Files Created or Modified
### New files (Phase 1 build)
- apps/desktop/src/main/auth/auth-service.ts
- apps/desktop/src/main/auth/auth-middleware.ts
- apps/desktop/src/main/auth/agent-permissions.ts
- apps/desktop/src/main/auth/index.ts
- apps/desktop/src/main/secrets/secrets-service.ts
- apps/desktop/src/main/secrets/integration-credentials-service.ts
- apps/desktop/src/main/secrets/index.ts
- apps/desktop/src/main/server.ts
- apps/desktop/src/main/routes/auth.ts
- apps/desktop/src/main/routes/projects.ts
- apps/desktop/src/main/routes/users.ts
- apps/desktop/src/main/routes/secrets.ts
- apps/desktop/src/main/routes/events.ts
- apps/desktop/src/main/routes/notifications.ts
- apps/desktop/src/main/notifications/notification-service.ts
- apps/desktop/src/main/notifications/index.ts
- apps/desktop/src/renderer/lib/api.ts
- apps/desktop/src/renderer/lib/sse.ts
- apps/desktop/src/renderer/store/auth.ts
- apps/desktop/src/renderer/store/projects.ts
- apps/desktop/src/renderer/store/notifications.ts
- apps/desktop/src/renderer/layouts/AppShell.tsx
- apps/desktop/src/renderer/components/ProtectedRoute.tsx
- apps/desktop/src/renderer/components/notifications/NotificationsPanel.tsx
- apps/desktop/src/renderer/pages/auth/SignIn.tsx
- apps/desktop/src/renderer/pages/projects/ProjectList.tsx
- apps/desktop/src/renderer/pages/Placeholder.tsx
- apps/desktop/src/renderer/App.tsx (replaced)
- apps/desktop/src/main/index.ts (updated — wires in startServer/stopServer)
- packages/database/src/migrations/0000_damp_madame_hydra.sql
- agent-state/handoffs/phase1-task4-output.md
- agent-state/handoffs/phase1-task5-output.md

### Modified (fixes)
- apps/desktop/src/main/auth/auth-service.ts — key persistence, exported getJwtSecret
- apps/desktop/src/main/secrets/secrets-service.ts — key persistence, removed sync stubs
- apps/desktop/src/main/secrets/index.ts — removed sync stubs from exports
- apps/desktop/src/main/routes/auth.ts — use getJwtSecret()
- apps/desktop/src/main/routes/events.ts — SSE query param auth, removed requireAuth dependency
- apps/desktop/src/main/routes/projects.ts — removed archivedAt from PatchProjectBody
- apps/desktop/src/main/notifications/notification-service.ts — count(), static import, dead code removed
- apps/desktop/src/renderer/layouts/AppShell.tsx — removed unused projects destructure

## Open Questions
- Phase 3: real OAuth (GitHub + Microsoft Entra) requires registered OAuth apps with redirect URIs. Phase 1 uses dev placeholder users.
- Input validation on routes (Fastify JSON schema) — deferred, should be added before Phase 2 domains start adding routes.

## Next Session Should Start With
Phase 2, Domain 6 (Integrations) — the external connector layer that the PM Command Center sits on top of. Task file is at docs/agents/tasks/ (needs to be written). Phase 1 is complete, reviewed, and all issues fixed. DB at schema v1.2.0 with all 25 tables.
