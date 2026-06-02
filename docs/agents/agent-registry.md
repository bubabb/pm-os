# Creare — Agent Registry
---
status: active
version: 1.0
last-updated: 2026-06-02
---

All agents working on Creare are registered here.
One entry per task. Updated as tasks are created.

---

## Phase 0 — Foundation

| Task | Agent Scope | Status | Output |
|---|---|---|---|
| #1 Tech Stack | Root — decisions only | ✅ Complete | `docs/sessions/session-2026-06-02-phase0-foundation.md` |
| #2 Scaffold | Root — all packages | ✅ Complete | Full monorepo structure |
| #3 Data Models | `packages/database/src/schema.ts` | 🔲 Pending | Canonical schema |
| #16 Project Scope | Docs only | ✅ Complete | `project-scope.md` |
| #19 Naming | Docs only | ✅ Complete | Product name: Creare |

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
