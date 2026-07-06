# Pm.Os App (headless)

## What This Is
The headless runtime for Pm.Os (Electron was removed 2026-07-06). Parts:
- **main/** — Fastify API server, SQLite access, auth/secrets, sync scheduler + push worker
- **server/** — headless entry (`headless.ts`, run via `tsx`) + the thin CLI (`cli.ts`)
- **renderer/** — React SPA (all 5 domain views + shared shell), built by `vite.web.config.ts` and served as a localhost web app

## Your Task Instructions
Read `/docs/agents/tasks/` for the specific task file assigned to this session before doing anything else.

## Files You Own
- `apps/desktop/src/**`
- `apps/desktop/vite.web.config.ts`
- `apps/desktop/package.json`

## Files You Read (Never Edit)
- `packages/*/src/index.ts` — domain public APIs
- `packages/*/CONTRACT.md` — domain interface contracts
- `packages/database/src/schema.ts` — canonical DB schema

## Key Architecture Rules
- Renderer talks to the backend only over the localhost HTTP API (`lib/api.ts`) — no Node.js access
- All domain logic lives in packages/* — this app is the runtime shell only
- Fastify server runs as a plain Node process (`server/headless.ts` via `tsx`) on localhost, port configurable (`PMOS_PORT`)
- Agent tasks (when built) run in Node worker/child processes — never in the server or renderer
- SSE endpoint on Fastify streams agent events to the renderer
