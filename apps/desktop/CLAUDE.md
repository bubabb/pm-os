# Pm.Os Desktop App

## What This Is
The Electron shell for Pm.Os. Three processes:
- **main/** — Node.js main process: Fastify API server, SQLite access, agent utility process management, IPC bridge
- **preload/** — Secure context bridge between main and renderer
- **renderer/** — React UI (all 5 domain views + shared shell)

## Your Task Instructions
Read `/docs/agents/tasks/` for the specific task file assigned to this session before doing anything else.

## Files You Own
- `apps/desktop/src/**`
- `apps/desktop/electron.vite.config.ts`
- `apps/desktop/package.json`

## Files You Read (Never Edit)
- `packages/*/src/index.ts` — domain public APIs
- `packages/*/CONTRACT.md` — domain interface contracts
- `packages/database/src/schema.ts` — canonical DB schema

## Key Architecture Rules
- Renderer never accesses Node.js APIs directly — use contextBridge + ipcRenderer
- All domain logic lives in packages/* — desktop app is the shell only
- Fastify server starts in main process on localhost, port configurable
- Agent tasks run in Electron Utility Processes — never in main or renderer
- SSE endpoint on Fastify streams agent events to renderer
