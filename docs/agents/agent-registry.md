# Pm.Os — Agent Registry
---
status: active
version: 1.0
last-updated: 2026-06-02
---

All agents working on Pm.Os are registered here.
One entry per task. Updated as tasks are created.

---

## Phase 0 — Foundation

| Task | Agent Scope | Status | Output |
|---|---|---|---|
| #1 Tech Stack | Root — decisions only | ✅ Complete | `docs/sessions/`, `docs/architecture/adr/001-004` |
| #2 Scaffold | Root — all packages | ✅ Complete | 84 files: monorepo, CLAUDE.md files, CONTRACT.md, AGENT-PROTOCOL.md, GLOSSARY.md, ADRs, agent-state/ |
| #3 Data Models | `packages/database/src/schema.ts` | ✅ Complete | 20 tables, 10 indexes, client.ts, data-models.md |
| #16 Project Scope | Docs only | ✅ Complete | `project-scope.md` v1.1 |
| #19 Naming | Docs only | ✅ Complete | Product name: Pm.Os, `docs/architecture/adr/004` |

**Phase 1 task instruction files (created end of Phase 0):**
- `docs/agents/tasks/phase1-task4-auth-rbac-secrets.md`
- `docs/agents/tasks/phase1-task5-database-api.md`
- `docs/agents/tasks/phase1-task6-ui-shell.md`
- `docs/agents/tasks/phase1-task17-notifications.md`

## Phase 1 — Core Infrastructure

| Task | Agent Scope | Status | Output |
|---|---|---|---|
| #4 Auth/RBAC + Secrets | `packages/database`, `apps/desktop/src/main` | 🔲 Pending | Auth system |
| #5 Database + API | `packages/database`, `apps/desktop/src/main` | 🔲 Pending | SQLite + Fastify |
| #6 UI Shell | `apps/desktop/src/renderer` | 🔲 Pending | React shell |
| #17 Notifications | Cross-cutting | 🔲 Pending | Notification system |

## Phase 2 — Domain Modules

| Task | Agent Scope | Status | Output |
|---|---|---|---|
| #7 Agent Orchestration | `packages/agent-orchestration` | 🔲 Pending | DAG engine |
| #8 Tool Registry | `packages/tool-registry` | 🔲 Pending | Tool registry |
| #9 Observability | `packages/observability` | 🔲 Pending | Trace + audit |
| #10 Boards | `packages/boards` | 🔲 Pending | Planning layer |
| #11 Reporting | `packages/reporting` | 🔲 Pending | Dashboards |
| #18 Global Search | Cross-cutting | 🔲 Pending | Search index |

## Phase 3 — Integration

| Task | Agent Scope | Status | Output |
|---|---|---|---|
| #12 Integration | All domains | 🔲 Pending | E2E flows |
| #13 MCP Integrations | `apps/desktop/src/main` | 🔲 Pending | External connectors |

## Phase 4 — Eval & Intelligence

| Task | Agent Scope | Status | Output |
|---|---|---|---|
| #14 Eval Harness | `packages/tool-registry` + CI | 🔲 Pending | Eval framework |
| #15 Team Memory | Cross-cutting | 🔲 Pending | Adaptive learning |
