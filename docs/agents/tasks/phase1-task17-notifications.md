# Agent Task: Phase 1 — Notifications & Alerts System (Task #17)
---
status: ready
phase: 1
task-id: 17
blocked-by: [1, 2, 3, 16, 19]
---

## Before You Start
Read in order:
1. `/project-scope.md` §5 (cross-cutting infrastructure)
2. `/docs/GLOSSARY.md`
3. `/docs/agents/AGENT-PROTOCOL.md`
4. `/packages/database/src/schema.ts` — focus on `notifications` table
5. `agent-state/handoffs/phase1-task5-output.md` — SSE stream is available

---

## Your Scope
You own:
- `apps/desktop/src/main/notifications/` — notification service and delivery
- `apps/desktop/src/main/routes/notifications.ts` — notification API routes

Do not touch:
- `packages/database/src/schema.ts` (read-only)
- SSE infrastructure in `apps/desktop/src/main/routes/events.ts` (use it, don't modify it)
- Renderer files (owned by Task #6)

---

## Context: What Exists
- `notifications` table in schema with types: `approval_needed`, `agent_failed`, `deployment_complete`, `cost_warning`, `mention`
- SSE `emitEvent(userId, event)` function from Task #5 — use this to push real-time notifications
- Auth middleware from Task #4 — all routes need `requireAuth`

---

## What You Must Produce

### 1. Notification service (`apps/desktop/src/main/notifications/notification-service.ts`)
```typescript
createNotification(input: {
  userId: string
  projectId?: string
  type: Notification['type']
  title: string
  body: string
  resourceType?: string
  resourceId?: string
}): Promise<Notification>

markAsRead(notificationId: string, userId: string): Promise<void>
markAllAsRead(userId: string, projectId?: string): Promise<void>
getUnreadCount(userId: string): Promise<number>
listNotifications(userId: string, limit?: number): Promise<Notification[]>
```

### 2. Real-time delivery
- After every `createNotification()`, call `emitEvent(userId, { type: 'notification.new', payload: notification })`
- The renderer's SSE client picks this up and updates the unread badge in real-time

### 3. Notification routes (`apps/desktop/src/main/routes/notifications.ts`)
- `GET /notifications` — list for current user, latest 50, with unread count
- `PATCH /notifications/:id/read` — mark single notification as read
- `POST /notifications/read-all` — mark all as read for current user

### 4. Cost warning trigger
- Export `checkCostThreshold(workspace: AgentWorkspace): Promise<void>`
- Fires a `cost_warning` notification when `costUsedTodayCents >= dailyCostLimitCents * 0.8` (80% threshold)
- Called by the agent orchestration domain after every agent execution (Phase 2)

### 5. Approval gate trigger
- Export `notifyApprovalNeeded(gate: ApprovalGate): Promise<void>`
- Fires an `approval_needed` notification to `gate.reviewerId`
- Called by the agent orchestration domain when a gate is created (Phase 2)

---

## Done When
- [ ] `createNotification()` inserts to DB and emits SSE event
- [ ] `GET /notifications` returns correct list for authenticated user
- [ ] Mark-as-read updates `readAt` timestamp correctly
- [ ] `getUnreadCount()` returns accurate count
- [ ] `checkCostThreshold()` fires notification at 80% of daily limit
- [ ] TypeScript compiles with zero errors
- [ ] All tests pass
- [ ] Handoff file written to `agent-state/handoffs/phase1-task17-output.md`
- [ ] `agent-state/agent-log.md` updated
- [ ] Session log written to `docs/sessions/`
