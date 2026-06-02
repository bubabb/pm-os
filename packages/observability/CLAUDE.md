# Domain: Observability
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## What This Domain Does
Makes Creare trustworthy. Full cross-agent visibility — trace viewer, decision log, replay engine, anomaly detection, and immutable audit log for compliance.

## Your Task Instructions
Read `/docs/agents/tasks/` for the specific task file assigned to this session.

## Files You Own
- `packages/observability/src/**`

## Files You Read (Never Edit)
- `packages/database/src/schema.ts` — DB schema, especially the event log table
- `packages/shared/src/**` — shared types

## Interface Contract
See `CONTRACT.md` in this directory.

## Key Features to Build (Phase 2)
- Cross-agent trace viewer (timeline + decision tree)
- Decision log: why did the agent do that?
- Replay engine: rerun any execution from any point
- Anomaly detection on pipeline health trends
- Incident management: link outages to agents/tasks
- Deployment risk scoring
- Immutable audit log (separate from traces — for compliance)

## Critical Distinction
- **Traces** = technical execution log (what code ran, what API was called)
- **Audit log** = authorization record (who approved what, when, why) — tamper-proof, for SOC2/HIPAA

## Design Principles
- Reads from the append-only event log — never writes to domain tables directly
- Audit log entries are immutable — no update or delete operations ever
- Replay must be deterministic — same inputs produce same outputs

## Do Not Build
- UI components (belongs in apps/desktop)
- Writing to non-observability tables (read other domains' event log entries only)
