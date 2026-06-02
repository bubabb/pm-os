# Agent Task: Phase 1 — Database Layer & Fastify API (Task #5)
---
status: ready
phase: 1
task-id: 5
blocked-by: [1, 2, 3, 16, 19]
---

## Before You Start
Read in order:
1. `/project-scope.md` §7 (design principles), §8 (technical direction)
2. `/docs/GLOSSARY.md`
3. `/docs/agents/AGENT-PROTOCOL.md`
4. `/packages/database/src/schema.ts` — full schema
5. `/packages/database/src/client.ts` — existing DB singleton
6. `agent-state/handoffs/phase1-task4-output.md` — auth middleware is ready

---

## Your Scope
You own:
- `apps/desktop/src/main/server.ts` — Fastify server bootstrap
- `apps/desktop/src/main/routes/` — all route handlers
- `packages/database/src/migrations/` — Drizzle migrations

Do not touch:
- `packages/database/src/schema.ts` (read-only)
- `apps/desktop/src/main/auth/` or `apps/desktop/src/main/secrets/` (owned by Task #4)
- Any renderer files

---

## Context: What Exists
- `packages/database/src/client.ts` — `getDb()` singleton with WAL mode + FK constraints
- `packages/database/src/schema.ts` — 20 tables, all fully defined
- Auth middleware from Task #4 — `requireAuth`, `requireRole`
- `apps/desktop/package.json` — Fastify + @fastify/cors already listed as dependencies

---

## What You Must Produce

### 1. Run all Drizzle migrations
```bash
pnpm --filter @creare/database run db:generate
pnpm --filter @creare/database run db:migrate
```
All 20 tables must exist in the SQLite database.

### 2. Fastify server (`apps/desktop/src/main/server.ts`)
- Starts on `localhost:4321` (configurable via env var `CREARE_PORT`)
- Registers `@fastify/cors` restricted to `localhost` origins only
- Registers `@fastify/swagger` for OpenAPI spec generation at `/docs`
- Mounts all route modules
- Exports `startServer(): Promise<void>` and `stopServer(): Promise<void>`
- Called from `apps/desktop/src/main/index.ts` after window creation

### 3. Base CRUD routes (`apps/desktop/src/main/routes/`)
- `projects.ts` — GET /projects, POST /projects, GET /projects/:id, PATCH /projects/:id, DELETE /projects/:id
- `users.ts` — GET /users/me, PATCH /users/me
- `secrets.ts` — GET /projects/:id/secrets, POST /projects/:id/secrets, DELETE /projects/:id/secrets/:secretId
- All routes protected with `requireAuth` middleware
- All routes return typed responses matching schema types from `@creare/database`

### 4. SSE endpoint (`apps/desktop/src/main/routes/events.ts`)
- `GET /events/stream` — Server-Sent Events stream per authenticated user
- Keeps connection alive with heartbeat every 30s
- `emitEvent(userId: string, event: SseEvent)` — called by other services to push to connected clients
- `SseEvent` type: `{ type: string, payload: unknown }`

### 5. Health check
- `GET /health` — returns `{ status: 'ok', version: string }` — no auth required

---

## Interface Contract (What Task #6 Needs From You)
The renderer connects to `http://localhost:4321`. Document in `agent-state/handoffs/phase1-task5-output.md`:
- Exact port and base URL
- Auth token format (how the renderer sends the JWT)
- SSE stream URL and event format
- OpenAPI spec location

---

## Done When
- [ ] All 20 tables created via Drizzle migrations
- [ ] Fastify starts cleanly on localhost:4321
- [ ] `GET /health` returns 200
- [ ] `GET /projects` returns 401 without auth token
- [ ] OpenAPI spec accessible at `/docs`
- [ ] SSE stream at `/events/stream` accepts connections and sends heartbeats
- [ ] TypeScript compiles with zero errors
- [ ] All tests pass
- [ ] Handoff file written to `agent-state/handoffs/phase1-task5-output.md`
- [ ] `agent-state/agent-log.md` updated
- [ ] Session log written to `docs/sessions/`
