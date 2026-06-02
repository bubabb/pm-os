# Session Log — 2026-06-02 — Feature Gap Analysis & Naming

## What Was Done
- Ran competitive uniqueness analysis against Azure AI Foundry, Palantir Foundry, GitHub Copilot, Kiln AI, Crucible AI, Linear, LangSmith, Devin/Factory.ai
- Confirmed platform combination is genuinely unique — DAG task engine + tool registry are true white spaces
- Identified 8 critical missing features and 3 important UX gaps
- Updated project-scope.md with all missing features across domains + new Cross-Cutting Infrastructure section
- Updated task descriptions for tasks #4, #5, #6, #7, #8, #9, #11
- Created task #17 (notifications system) and task #18 (global search)
- Wired blocking dependencies for new tasks
- Ran full naming brainstorm — checked Foundry, Crucible, Anvil, Kiln, Atelier
- Tech stack approval locked in (Task #1 marked complete)

## Decisions Made
- **Naming:** All researched names are taken in DevOps/AI space. Foundry (Microsoft/Palantir), Crucible (Crucible AI + Atlassian), Anvil (dev tools), Kiln (direct AI competitor), Atelier (clear but rejected by user). Naming still TBD.
- **Competitive position:** Unique as a combination. Lead with Agent Orchestration + Tool Registry — these are the true differentiators. Boards/Reporting are supporting context, not the headline.
- **Microsoft risk:** Azure AI Foundry is moving fast (MCP Toolboxes in May 2026). Defense: local-first, model-agnostic, not Azure-locked.
- **Critical missing features added:** Secrets management (Phase 1), Agent permission scoping (Phase 1), Notifications (Phase 1 — Task #17), Multi-project workspace (Phase 1), Rate limiting/cost guardrails (Phase 2 agent orchestration), Rollback (Phase 2 tool registry), Immutable audit log (Phase 2 observability), Usage/cost tracking (Phase 2 reporting), Global search (Phase 2 — Task #18), Project templates (Phase 1 UI), Local backup/recovery (Phase 1 DB)

## Files Created or Modified
- `/Users/bubagv/Desktop/devops_platform/project-scope.md` — major update: new features in all 5 domains + new Cross-Cutting Infrastructure section
- `/Users/bubagv/Desktop/devops_platform/project-scope.txt` — synced
- Tasks #4, #5, #6, #7, #8, #9, #11 — descriptions updated
- Tasks #17, #18 — created with blocking dependencies

## Open Questions
- App name still TBD — user didn't like Atelier. Explored: Synapse, Cortex, Torque, Fulcrum, Faber, Opus, Pragma, Keystone, Epoch, Relay, Bureau. No searches run yet on these.
- Scope doc version should be bumped to 1.1 to reflect today's feature additions

## Next Session Should Start With
1. Finalize app name — search remaining candidates (Synapse, Cortex, Fulcrum, Pragma, Opus)
2. Bump scope doc to v1.1
3. Complete Task #2 — scaffold the monorepo (still in progress)
