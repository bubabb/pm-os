# Observability — Interface Contract
---
status: draft
version: 0.1
last-updated: 2026-06-02
---

## Exports (Public API)
To be defined in Phase 0 Task #3 and finalized in Phase 2 Task #9.

## Dependencies
- `@creare/database` — reads event log, writes trace and audit records
- `@creare/shared` — shared types

## Consumed By
- `apps/desktop` — renders trace viewer, audit log UI
- `@creare/reporting` — reads anomaly and deployment risk data
