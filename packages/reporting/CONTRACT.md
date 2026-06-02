# Reporting — Interface Contract
---
status: draft
version: 0.1
last-updated: 2026-06-02
---

## Exports (Public API)
To be defined in Phase 0 Task #3 and finalized in Phase 2 Task #11.

## Dependencies
- `@creare/database` — reads event log and reporting-specific tables
- `@creare/shared` — shared types
- `@creare/ai-sdk` — NL query processing, summary generation
- `@creare/observability` — anomaly and risk data
- `@creare/boards` — sprint and milestone data

## Consumed By
- `apps/desktop` — renders all reporting and dashboard views
