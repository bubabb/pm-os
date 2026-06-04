# Agent Task: Phase 2 — Domain 5: Reporting & PM Command Center

---
status: ready
phase: 2
task-id: 22
blocked-by: [21]
---

## Before You Start
Read in order:
1. `/project-scope.md` §5 Domain 5 — especially PM Command Center
2. `/packages/reporting/CLAUDE.md` and `CONTRACT.md`
3. `agent-state/handoffs/phase2-domain6-output.md` — Domain 6 public API
4. `/packages/database/src/schema.ts` — sprints, milestones, traces, cost_records

## Architecture Note
Domain 4 (Boards) is not yet built. Read sprint/milestone data directly from DB in Phase 2.
Wire through `@creare/boards` public API in Phase 3 Integration sprint.

## Dashboard Data Flow
```
GET /projects/:id/dashboard
  → sprintReader.getSprintContext(projectId)          // DB: sprints, milestones
  → integrations.getActiveEvents(projectId)           // DB: external_event_cache
  → integrations.classifyItems(projectId, rows, key)  // Rule engine + LLM fallback
  → agentActivity.getTraces(projectId)                // DB: traces (today)
  → digest = getLatestDigest() ?? { isStale: true }   // DB: pm_digest_cache
  → return combined DashboardResponse
```

## DashboardResponse contract
```typescript
interface DashboardResponse {
  sprintContext: {
    activeSprint: { name: string; dayNumber: number; totalDays: number; endsAt: string } | null
    atRiskMilestones: { title: string; daysUntilDue: number; status: string }[]
    overnightDelta: number    // items fetched in last 24h
    lastSyncedAt: string | null
  }
  classified: {
    doNow: ClassifiedItem[]     // bucket: 'human', sorted urgency DESC
    delegate: ClassifiedItem[]  // bucket: 'agent', sorted urgency DESC
    risks: ClassifiedItem[]     // riskType !== null, any bucket
  }
  agentActivity: {
    running: TraceStub[]
    completedToday: TraceStub[]
    failed: TraceStub[]
  }
  digest: {
    morningBrief: string | null
    isStale: boolean
    generatedAt: string | null
  }
}

interface TraceStub {
  id: string
  taskTitle: string | null
  agentWorkspaceName: string
  status: string
  startedAt: string
  durationMs: number | null
  costCents: number
}
```

## What You Must Produce

### Backend: `packages/reporting/src/`

**`sprint-reader.ts`**
- `getSprintContext(projectId)` — reads active sprint, calculates day number, finds at-risk milestones (dueDate within 14 days or status === 'at_risk'), overnight delta (events fetched in last 24h from external_event_cache)

**`agent-activity.ts`**
- `getTraces(projectId)` — returns running traces, traces completed today, traces failed (any time). Joins with agent_workspaces for name, tasks for title.

**`pm-command-center.ts`**
- `getDashboard(projectId, apiKey)` — full orchestration per data flow above. If no credentials configured: returns empty classified + empty agentActivity + null sprintContext.
- `triggerBackgroundDigest(projectId, items, apiKey)` — generates all 4 digest types asynchronously, does not await.

**`cost-tracking.ts`**
- `recordCost(input: NewCostRecord)` — inserts to cost_records
- `getProjectSpend(projectId, since?)` — total spend + breakdown by agent workspace

**`nl-queries.ts`**
- `queryProject(projectId, question, apiKey)` — NL query using Haiku, context = recent events + sprint state
- `generateSprintSummary(sprintId, apiKey)` — sprint summary using Sonnet
- `generateExecutiveSummary(projectId, apiKey)` — exec summary using Sonnet
- `generateChangelog(projectId, since, apiKey)` — changelog using Haiku

**`index.ts`** — export all public functions

### Desktop: `apps/desktop/src/main/routes/reporting.ts`
Routes (all auth-protected, all require project ownership):
- `GET /projects/:id/dashboard` — getDashboard (fetches ANTHROPIC_API_KEY secret, passes to service)
- `POST /projects/:id/dashboard/refresh` — trigger sync on all credentials, then getDashboard
- `GET /projects/:id/dashboard/digest/:type` — getLatestDigest, or trigger generation if stale
- `POST /projects/:id/dashboard/delegate` — body: { entity, suggestedAction } — creates a notification of type 'mention' as a delegation log stub (Domain 1 will replace this in Phase 3)
- `GET /projects/:id/reports/query?q=` — queryProject with q param

### Frontend: `apps/desktop/src/renderer/pages/reports/`

**`store/dashboard.ts`** — Zustand store:
```typescript
{
  data: DashboardResponse | null
  isLoading: boolean
  lastLoadedAt: string | null
  delegatingItem: ClassifiedItem | null  // item in the delegate drawer
  load(projectId): Promise<void>
  refresh(projectId): Promise<void>  // triggers sync then reloads
  setDelegating(item: ClassifiedItem | null): void
  delegate(projectId, item, action): Promise<void>
}
```

**`PMCommandCenter.tsx`** — page root. Loads data on mount. Shows onboarding state when no integrations configured.

**`ContextStrip.tsx`** — top bar showing:
- Sprint name + "Day X of Y"
- At-risk milestones (🔴 badge + name + days remaining)
- "N items" overnight delta
- Last synced timestamp + manual refresh button

**`DoNowPanel.tsx`** — left primary panel:
- Sorted by urgency DESC
- Each item: urgency badge (🔴 urgency 4-5 / 🟡 urgency 3 / 🟢 urgency 1-2), source icon (Jira/GitHub), title, suggested action, "Acknowledge" button (removes from view, future: creates PM task)

**`DelegatePanel.tsx`** — right secondary panel:
- Each item: source icon, title, suggested action, "Delegate ▶" button
- Clicking Delegate opens DelegateConfigDrawer

**`DelegateConfigDrawer.tsx`** — slide-in side panel:
- Shows: what the agent will do (suggestedAction), source, title
- "Confirm & Delegate" button → calls delegate API → closes drawer → removes from list
- "Cancel" → closes without action

**`AgentActivityPanel.tsx`** — below DelegatePanel:
- Three subsections: Running (⟳ spinner), Completed today (✓), Failed (✗ with retry button stub)
- Each row: agent workspace name, task title or "Unnamed task", duration or "running…", cost in cents

**`RiskRadar.tsx`** — full-width bottom panel:
- Each risk: severity icon (🔴🟡🟢), description, risk type badge, "Handle it" (→ adds to DO NOW) or "Delegate▶" (→ opens drawer) button

## Done When
- [ ] getDashboard returns correct structure for project with no credentials (empty state)
- [ ] getDashboard returns classified items split into doNow / delegate / risks
- [ ] getTraces correctly categorises running / completed today / failed
- [ ] POST /dashboard/delegate creates notification and returns ok
- [ ] PM Command Center renders in Electron without errors
- [ ] ContextStrip shows sprint day and last sync time
- [ ] DO NOW items sorted by urgency, correct badges
- [ ] DELEGATE panel shows agent items; drawer opens on click
- [ ] Agent Activity shows running / completed / failed subsections
- [ ] Risk Radar renders risk items with Handle/Delegate buttons
- [ ] Onboarding state shown when no integrations configured
- [ ] TypeScript compiles with zero errors across all files
- [ ] Session log written to docs/sessions/
