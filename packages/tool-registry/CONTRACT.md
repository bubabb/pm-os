# Tool Registry — Interface Contract
---
status: active
version: 1.0
last-updated: 2026-06-02
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

## Public API (finalized in Phase 2 Task #8)
```typescript
// Tool management
createTool(input: NewTool): Promise<Tool>
publishVersion(toolId: string, input: Omit<NewToolVersion, 'toolId'>): Promise<ToolVersion>
deploy(toolId: string, versionId: string): Promise<ToolDeployment>
rollback(toolId: string): Promise<ToolDeployment>  // rolls back to previousVersionId

// Discovery
listTools(projectId: string): Promise<Tool[]>
getToolVersion(versionId: string): Promise<ToolVersion>
```

## Dependencies
- `@creare/database` — read/write tools, tool_versions, tool_deployments, events
- `@creare/shared` — `generateId()`

## Consumed By
- `apps/desktop` — tool registry UI, deploy/rollback controls
- `@creare/agent-orchestration` — agents reference tools by ID + version
- `@creare/observability` — reads tool deployment events
- `@creare/reporting` — tool usage analytics
