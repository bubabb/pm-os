# Boards — Interface Contract
---
status: draft
version: 0.1
last-updated: 2026-06-02
---

## Exports (Public API)
To be defined in Phase 0 Task #3 and finalized in Phase 2 Task #10.

## Dependencies
- `@creare/database` — read/write board items, sprints, milestones
- `@creare/shared` — shared types
- `@creare/agent-orchestration` — link board tasks to DAG nodes

## Consumed By
- `apps/desktop` — renders all board views
- `@creare/reporting` — reads sprint velocity, milestone data
