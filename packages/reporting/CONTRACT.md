# Reporting — Interface Contract
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## Schema Types Consumed
From `@pm-os/database`:
```typescript
import type {
  CostRecord, NewCostRecord,
  Event,
  Trace,
  Sprint,
  Milestone,
} from '@pm-os/database'
```

## Events Emitted to Event Log
All events use `domain: 'reporting'`.

| Event Type | Trigger | Payload |
|---|---|---|
| `cost.record.created` | Model API call tracked | `{ workspaceId, provider, costCents, tokens }` |

## Public API (finalized in Phase 2 Task #11)
```typescript
// Cost tracking
recordCost(input: NewCostRecord): Promise<CostRecord>
getProjectSpend(projectId: string, since?: string): Promise<{ totalCents: number, byAgent: Record<string, number> }>

// NL queries
queryProject(projectId: string, question: string): Promise<string>  // "what shipped this week?"

// Summaries
generateSprintSummary(sprintId: string): Promise<string>
generateExecutiveSummary(projectId: string): Promise<string>
generateChangelog(projectId: string, since: string): Promise<string>
```

## Dependencies
- `@pm-os/database` — reads events log, traces, cost_records, sprints, milestones; writes cost_records
- `@pm-os/shared` — `generateId()`
- `@pm-os/ai-sdk` — NL query processing and summary generation
- `@pm-os/observability` — anomaly detection data
- `@pm-os/boards` — sprint velocity and milestone data

## Consumed By
- `apps/desktop` — all reporting and dashboard views
