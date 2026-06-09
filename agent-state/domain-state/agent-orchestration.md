# Domain State: Agent Orchestration
**Status:** Implemented (Phase 3) + review fixes applied — tsc pending on Mac
**Last updated:** 2026-06-09

## Implemented
- Workspaces, DAG tasks + edges (cycle detection), approval gates — `packages/agent-orchestration/src/index.ts`
- Routes: `apps/desktop/src/main/routes/orchestration.ts`; UI: `AgentsPage.tsx`

## Review fixes (2026-06-09)
- Events emitted for workspace status changes + terminate; `task.updated` for non-status edits;
  `task.created` payload includes taskId/projectId; `approval.gate.resolved` per contract.
- `addEdge` validates both endpoints belong to the project; cycle-check + insert are transactional.
- `createApprovalGate` rejects orphan gates (task must exist).
- Routes: sub-resource ownership guards (workspace/task in project); `actorId` threaded.

## Outstanding
- `tsc --noEmit` on Mac. Watch drizzle `.transaction()` typing in `addEdge`.
