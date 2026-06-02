# Observability — Interface Contract
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## Schema Types Consumed
From `@creare/database`:
```typescript
import type {
  Event, NewEvent,
  Trace, NewTrace,
  TraceEvent, NewTraceEvent,
  AuditLog, NewAuditLog,
} from '@creare/database'
```

## Append-Only Tables — Critical Rule
This domain reads from and writes to THREE append-only tables.
**Never UPDATE or DELETE from `events`, `trace_events`, or `audit_log`.**

## Events Written
This domain does not emit to the `events` log (it reads it).
It writes directly to `traces`, `trace_events`, and `audit_log`.

## Public API (finalized in Phase 2 Task #9)
```typescript
// Traces
startTrace(input: NewTrace): Promise<Trace>
appendTraceEvent(input: NewTraceEvent): Promise<TraceEvent>
completeTrace(traceId: string, outcome: Pick<Trace, 'status' | 'durationMs' | 'costCents'>): Promise<void>

// Audit log
writeAuditEntry(input: NewAuditLog): Promise<AuditLog>

// Query
getTrace(traceId: string): Promise<Trace & { events: TraceEvent[] }>
getProjectEvents(projectId: string, filters?: { domain?: string, type?: string, since?: string }): Promise<Event[]>
getAuditLog(projectId: string, since?: string): Promise<AuditLog[]>
```

## Dependencies
- `@creare/database` — reads events log; writes traces, trace_events, audit_log
- `@creare/shared` — `generateId()`

## Consumed By
- `apps/desktop` — trace viewer, audit log UI, observability dashboards
- `@creare/reporting` — anomaly data, deployment risk scores
