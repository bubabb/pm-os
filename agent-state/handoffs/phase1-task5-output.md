# Handoff: Phase 1 Task #5 — Database Migrations & Fastify API

**Status:** Complete  
**Completed:** 2026-06-03

## What Was Built

### Database
- All 25 tables migrated. Migration file: `packages/database/src/migrations/0000_damp_madame_hydra.sql`
- DB lives at `~/.pmos/pmos.db` (created on first run)
- Schema circular ref fixed: `tools.latestVersionId` now uses `references((): AnySQLiteColumn => toolVersions.id)`
- `drizzle-kit` updated to v0.31.10 — scripts in `packages/database/package.json` updated to use direct node path

### Fastify Server
- `apps/desktop/src/main/server.ts` — starts on `http://127.0.0.1:4321` (configurable via `PMOS_PORT`)
- CORS restricted to localhost origins only
- `@fastify/swagger` + `@fastify/swagger-ui` — OpenAPI spec at `/docs`
- `startServer()` / `stopServer()` called from `apps/desktop/src/main/index.ts`

### Routes
- `GET /health` — `{ status, version, timestamp }`, no auth required
- `GET|POST|GET/:id|PATCH/:id|DELETE/:id /projects` — full CRUD, owner-scoped, soft-delete via `archivedAt`
- `GET|PATCH /users/me`
- `GET|POST|DELETE /projects/:id/secrets` — plaintext never returned
- `GET /events/stream` — SSE, heartbeat every 30s, auto-cleanup on disconnect
- `POST /auth/sign-in` — returns `{ token, user }`, Phase 1 dev user
- `GET /auth/me` — validates token, returns user
- `GET|PATCH /:id/read|POST /read-all /notifications`

## For Task #6 (Renderer)
- **Base URL:** `http://localhost:4321`
- **Auth:** `Authorization: Bearer <jwt>` on every request (except `/health`, `/auth/sign-in`)
- **SSE:** `GET /events/stream?token=<jwt>` — EventSource doesn't support headers
- **OpenAPI:** `http://localhost:4321/docs`

## SSE Event Shape
```typescript
{ type: string, payload: unknown }
// e.g. { type: 'notification.new', payload: Notification }
//       { type: 'connected', payload: { userId: string } }
```
