# Pm.Os — Root Claude Instructions

## About This Project
**Pm.Os** is an agentic DevOps platform for AI-native software teams. Local-first Electron desktop app. Latin: "to create."

**Master reference:** Always read `project-scope.md` before making any architectural, feature, or UX decision.  
**Glossary:** Read `docs/GLOSSARY.md` before writing any code — all domain terms must match canonical definitions.  
**Protocol:** Read `docs/agents/AGENT-PROTOCOL.md` before starting any task.

---

## Monorepo Structure

```
apps/desktop/          → Electron app (main, preload, renderer)
packages/
  agent-orchestration/ → Domain 1: DAG task engine, agent workspaces
  tool-registry/       → Domain 2: versioned AI tool artifacts
  observability/       → Domain 3: trace viewer, audit log, replay
  boards/              → Domain 4: planning, Kanban, Gantt
  reporting/           → Domain 5: NL dashboards, exec summaries, PM Command Center
  integrations/        → Domain 6: external connectors (Jira, GitHub, Confluence, Notion, OneDrive), sync engine, classifier
  database/            → Shared: SQLite + Drizzle ORM, event log
  ai-sdk/              → Shared: model-agnostic AI wrapper
  shared/              → Shared: types, constants, utilities
docs/                  → Architecture, ADRs, agent instructions, glossary
agent-state/           → Inter-agent communication, append-only log
```

---

## Tech Stack (Approved 2026-06-02)
- **Language:** TypeScript everywhere
- **Monorepo:** Turborepo + pnpm
- **Desktop:** Electron + electron-vite + Electron Forge
- **UI:** React + Tailwind CSS + shadcn/ui
- **State:** Zustand + TanStack Query
- **API:** Fastify (localhost HTTP, v1)
- **Real-time:** Server-Sent Events (SSE)
- **Agent execution:** Electron Utility Processes
- **Database:** SQLite + Drizzle ORM
- **Event log:** Append-only SQLite table
- **AI:** Model-agnostic wrapper (packages/ai-sdk)
- **MCP:** MCP TypeScript SDK
- **Testing:** Vitest + Playwright
- **Sync (v2):** ElectricSQL

---

## Non-Negotiable Rules
1. **UUIDs everywhere** — never auto-increment IDs
2. **Append-only event log** — all state changes are events, never mutations
3. **No server-assumed features** — everything works offline in v1
4. **TypeScript strict mode** — no `any`, no exceptions
5. **Each domain owns its files** — never edit files outside your domain package
6. **Read CONTRACT.md** before calling any cross-domain API
7. **Write session log** at the end of every task to `docs/sessions/`

---

## Design Principles (from project-scope.md §7)
1. Agent-first, human-supervised
2. Tool as artifact
3. Observability by default
4. Zero cold-start
5. Model-agnostic
6. Composable (MCP + OpenAPI)
7. Stakeholder-readable by default
8. Opinionated defaults, flexible overrides

---

## Workflows & Resume (any agent, any machine)
This project lives in the `~/projects` mother folder and carries its own hooks in
`.claude/`, so the workflows fire regardless of which machine opens it.

- **Resume:** `PROGRESS.md` at the project root is the at-a-glance state — **read it first**.
  The detailed append-only history is `agent-state/agent-log.md`.
- **`deepreview`** in a prompt → three-pass review (`.claude/review-methodology.md`):
  Ground → Verify → Break-it, ending VERIFIED / ASSUMED / COULD NOT VERIFY.
- **`done for the day`** in a prompt → wrap-up (`.claude/save-methodology.md`):
  updates `PROGRESS.md` + the auto-memory pointer. (This is in addition to Rule 7's
  per-task `docs/sessions/` log.)
- Per-project hooks need a one-time trust approval the first time the project is
  opened on a machine (incl. the Mac).
