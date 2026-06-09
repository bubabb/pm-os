# Tool Registry — Interface Contract
---
status: active
version: 1.1
last-updated: 2026-06-08
---

## Schema Types Consumed
From `@creare/database`:
```typescript
import type {
  Tool, NewTool,
  ToolVersion, NewToolVersion,
  ToolDeployment, NewToolDeployment,
  Event, NewEvent,
} from '@creare/database'
```

## Events Emitted to Event Log
All events use `domain: 'tool-registry'`.

| Event Type | Trigger | Payload |
|---|---|---|
| `tool.created` | New tool registered | `{ toolId, projectId, name }` |
| `tool.version.published` | New version published | `{ toolId, versionId, version, publishedBy }` |
| `tool.deployed` | Version deployed to active | `{ toolId, versionId, deploymentId }` |
| `tool.rolled_back` | Deployment rolled back | `{ toolId, fromVersionId, toVersionId, deploymentId }` |
| `tool.deployment.failed` | Deployment failed | `{ toolId, deploymentId, error: string }` |

## Public API (implemented Phase 3, 2026-06-08)
Synchronous (better-sqlite3 via `getDb()`), matching the boards / agent-orchestration
domains. `actorId` params populate the NOT-NULL `*ById` columns and event `actorId`.

```typescript
// Tool management
listTools(projectId: string): Tool[]
getTool(id: string): Tool | null
createTool(projectId: string, params: { name: string; description?: string }, createdById: string): Tool

// Version management (immutable)
listVersions(toolId: string): ToolVersion[]
getToolVersion(versionId: string): ToolVersion | null
publishVersion(
  toolId: string,
  params: { version: string; schema: string; implementation: string; changelog?: string },
  publishedById: string,
): ToolVersion           // also repoints tools.latestVersionId

// Deployment management (single active per tool)
listDeployments(toolId: string): ToolDeployment[]
getActiveDeployment(toolId: string): ToolDeployment | null
deploy(toolId: string, versionId: string, deployedById: string): ToolDeployment
rollback(toolId: string, deployedById: string): ToolDeployment   // restores previousVersionId
```

> **Changed from v1.0:** signatures are synchronous (not `Promise`), and take an explicit
> `actorId`. `getTool`/`listVersions`/`listDeployments`/`getActiveDeployment` added.
> `tool.deployment.failed` event is reserved (not emitted in v1 — local deploys are atomic).

## Deployment status values
`tool_deployments.status` ∈ `deploying | active | rolled_back | superseded | failed`:
- `active` — the single current deployment for a tool.
- `superseded` — a prior active deployment replaced by a forward `deploy()` (not a rollback).
- `rolled_back` — a deployment that was explicitly reverted via `rollback()`.

The `/projects/:id/tools/:toolId/deployments/active` route returns `{ deployment: ToolDeployment | null }`.

## Dependencies
- `@creare/database` — read/write tools, tool_versions, tool_deployments, events
- `@creare/shared` — `generateId()`

## Consumed By
- `apps/desktop` — tool registry UI, deploy/rollback controls
- `@creare/agent-orchestration` — agents reference tools by ID + version
- `@creare/observability` — reads tool deployment events
- `@creare/reporting` — tool usage analytics
