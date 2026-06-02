# Agent Orchestration — Interface Contract
---
status: draft
version: 0.1
last-updated: 2026-06-02
---

## Exports (Public API)
To be defined in Phase 0 Task #3 (data models) and finalized in Phase 2 Task #7.

## Events Emitted to Event Log
To be defined in Phase 0 Task #3.

## Dependencies (What This Domain Consumes)
- `@creare/database` — read/write DAG nodes, edges, agent workspaces
- `@creare/shared` — UUID generation, base types
- `@creare/ai-sdk` — execute agent tasks via model-agnostic wrapper

## Consumed By
- `apps/desktop` — renders DAG UI, approval gate prompts
- `@creare/observability` — reads agent execution events from event log
- `@creare/reporting` — reads agent SLA/cost data
