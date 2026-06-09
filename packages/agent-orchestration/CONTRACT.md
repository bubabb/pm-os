# Agent Orchestration — Interface Contract
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## Schema Types Consumed
From `@creare/database`:
```typescript
import type {
  AgentWorkspace, NewAgentWorkspace,
  Task, NewTask,
  TaskEdge, NewTaskEdge,
  ApprovalGate, NewApprovalGate,
  Event, NewEvent,
} from '@creare/database'
```

## Events Emitted to Event Log
All events use `domain: 'agent-orchestration'`.

| Event Type | Trigger | Payload |
|---|---|---|
| `task.created` | New task inserted into DAG | `{ taskId, projectId, type, title }` |
| `task.started` | Task execution begins | `{ taskId, agentWorkspaceId }` |
| `task.completed` | Task execution succeeds | `{ taskId, durationMs }` |
| `task.failed` | Task execution fails | `{ taskId, error: string }` |
| `task.cancelled` | Task manually cancelled | `{ taskId, cancelledBy: userId }` |
| `agent.workspace.created` | New workspace registered | `{ workspaceId, modelProvider, modelId }` |
| `agent.workspace.activated` | Workspace begins task execution | `{ workspaceId, taskId }` |
| `agent.workspace.status_changed` | Workspace status changed (non-terminal) | `{ status, previousStatus }` |
| `agent.workspace.terminated` | Workspace terminated | `{ status, previousStatus }` |
| `task.updated` | Task fields changed (non-status) | `{ taskId, changed: string[] }` |
| `approval.gate.created` | Agent requests human approval | `{ gateId, taskId, reviewerId }` |
| `approval.gate.resolved` | Human approves or rejects gate | `{ gateId, status, reviewerId }` |
| `agent.cost.warning` | 80% of daily cost limit reached | `{ workspaceId, costUsedCents, limitCents }` |

## Public API (finalized in Phase 2 Task #7)
```typescript
// DAG execution
createTask(input: NewTask): Promise<Task>
addEdge(fromTaskId: string, toTaskId: string): Promise<TaskEdge>  // must check for cycles first
startTask(taskId: string): Promise<void>
cancelTask(taskId: string): Promise<void>

// Agent workspaces
createWorkspace(input: NewAgentWorkspace): Promise<AgentWorkspace>
getWorkspaceStatus(workspaceId: string): Promise<AgentWorkspace['status']>

// Approval gates
createApprovalGate(input: NewApprovalGate): Promise<ApprovalGate>
resolveApprovalGate(gateId: string, status: 'approved' | 'rejected', note?: string): Promise<void>
```

## Dependencies (What This Domain Consumes)
- `@creare/database` — read/write tasks, task_edges, agent_workspaces, approval_gates, events
- `@creare/shared` — `generateId()`
- `@creare/ai-sdk` — execute agent tasks via model-agnostic wrapper
- Notifications service — `notifyApprovalNeeded()`, `checkCostThreshold()`

## Consumed By
- `apps/desktop` — DAG UI, approval gate prompts, workspace status
- `@creare/observability` — reads agent execution events from event log
- `@creare/boards` — links board items to DAG task nodes
- `@creare/reporting` — reads agent SLA/cost data
