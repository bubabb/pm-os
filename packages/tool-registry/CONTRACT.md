# Tool Registry — Interface Contract
---
status: draft
version: 0.1
last-updated: 2026-06-02
---

## Exports (Public API)
To be defined in Phase 0 Task #3 (data models) and finalized in Phase 2 Task #8.

## Events Emitted to Event Log
To be defined in Phase 0 Task #3.

## Dependencies
- `@creare/database` — read/write tool versions, artifacts, deployments
- `@creare/shared` — UUID generation, base types

## Consumed By
- `apps/desktop` — renders tool registry UI
- `@creare/agent-orchestration` — agents reference tools by ID + version
- `@creare/observability` — tracks tool deployment events
- `@creare/reporting` — tool usage analytics
