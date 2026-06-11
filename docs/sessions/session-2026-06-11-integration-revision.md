# Session Log — 2026-06-11 — Integration revision (make it one app, not siloed tabs)

## What Was Done
Driven by user feedback ("tabs/data/connections don't communicate; looks like a static app
I can't use"). Ran a **Fable 5 deep review** (3 parallel reviewers: data-flow backbone /
cross-tab + button audit / selection model), grounded in the live DB, then executed all
findings in **two waves of 5 parallel Fable 5 agents each** on disjoint files.

### Diagnosis (root causes of "static/siloed")
- Binding a source triggered NO sync; scheduler skips boot, runs every 15 min.
- Empty/failed GitHub fetch recorded as silent success (the user's `bubabb/theantidote`
  synced 0 items — likely no OPEN issues/PRs, or token visibility).
- Dashboard equated "empty cache" with "no integrations" → showed "Connect your tools"
  even though GitHub was connected, and hid the Sync button behind that gate.
- Sources list never read sync state ("Never synced" forever).
- Synced data had no browsable home; no cross-tab handoffs (tasks couldn't reach Boards,
  Delegate over-promised + no feedback, notifications had zero producers, agent Start/Pause
  implied execution that isn't built).

### Wave 1 — data flow visible + multi-select (commit 14b1b3a)
- routes/integrations.ts: auto-sync on source add; `POST /integrations/bulk` (multi-select);
  enriched GET list with lastSyncedAt/syncStatus/syncError.
- github connector: throws a clear error on repo 404 (token/visibility) instead of silent 0.
- reporting/pm-command-center: dashboard `integrations{connectedCount,syncedItemCount,
  lastSyncedAt}` → 3 honest states; updated the one test that asserted old `hasIntegrations`.
- Settings Sources: multi-select picker (Map state, N inserts via bulk), sync feedback loop
  (poll /status → toast), real last-synced/error display, browsable "synced items" view.
- reports: 3-state onboarding + always-reachable Sync CTA; `syncAndRefresh` in dashboard
  store polls status then toasts (no more fire-and-forget).

### Wave 2 — wire tabs together + honest buttons (commit 8394a55)
- BoardsPage: "+ Add task" per column (picker over project tasks) → POST board items; Kanban
  can finally hold cards.
- reports: honest Delegate copy + success "View in Agents", invalidate tasks/timeline; Risk
  "Handle it" creates a real human task; acknowledge/dismiss persist per project (localStorage);
  AgentActivity rows link to Observability.
- AgentsPage: honest Start/Pause labelling (no fake execution), gate resolve refreshes
  tasks/timeline, task "View on Timeline" cross-link, honest gate empty state.
- Notifications: real producers (delegate→task, source bound) so the bell lights up; rows
  deep-link by resourceType.
- Observability/Intelligence: honest empty states explaining what feeds each surface +
  cross-links; Intelligence gains a real "Run smoke suite" eval CTA.

## Decisions Made
- Multi-select needs NO schema change (integration_credentials is already per-row); N inserts.
- Agent EXECUTION stays unbuilt (per prior decision) — instead, relabel honestly everywhere
  rather than fake activity.
- Project color/emoji/acknowledgements stay client-side (localStorage), no migrations.
- Notifications use the existing 5-value type enum (`mention` for informational) — no schema change.

## Files Created or Modified
Wave 1: routes/integrations.ts, connectors/github.ts, reporting/pm-command-center.ts(+test),
routes/reporting.ts, Settings.tsx, PMCommandCenter.tsx, ContextStrip.tsx, store/dashboard.ts.
Wave 2: BoardsPage.tsx, store/dashboard.ts, PMCommandCenter.tsx, DelegateConfigDrawer.tsx,
RiskRadar.tsx, AgentActivityPanel.tsx, AgentsPage.tsx, routes/reporting.ts,
routes/integrations.ts, NotificationsPanel.tsx, ObservabilityPage.tsx, IntelligencePage.tsx.

## Verification
Full static gate GREEN both waves: typecheck 23/23 · unit 81/81 · lint 12/12.
E2E COULD NOT RUN this session — the tool sandbox kills Electron launches (exit 144); needs
verifying in the live `pnpm dev` app. (Earlier in the day E2E was 2/2 before the sandbox issue.)

## Open Questions / Next Session
- Verify the new flows live in `pnpm dev`: bind a repo (now auto-syncs + shows "0 open items"
  honestly), multi-select repos, Add task to board, Delegate→View in Agents, bell lights up.
- `bubabb/theantidote` likely has no OPEN issues/PRs → will legitimately sync 0 items; the UI
  now says so instead of looking broken.
- Still deferred: agent execution runtime; per-credential (not per-source) sync; raise the
  GitHub 200-repo picker cap; OAuth token refresh.
- Earlier crypto fragility noted (safeStorage key rotation orphaned a token) — re-adding fixed
  it; a hardening pass was offered and deferred.

## Next Session Should Start With
Live-verify both waves in the running app, then decide whether to build the agent-execution
runtime (the last big "it actually does the thing" piece) or harden token encryption.
