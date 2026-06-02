# Domain: Reporting
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## What This Domain Does
Turns engineering activity into executive-readable intelligence automatically. NL project queries, AI-generated summaries, multi-audience dashboards, usage/cost tracking, and predictive analytics.

## Your Task Instructions
Read `/docs/agents/tasks/` for the specific task file assigned to this session.

## Files You Own
- `packages/reporting/src/**`

## Files You Read (Never Edit)
- `packages/database/src/schema.ts` — DB schema
- `packages/shared/src/**` — shared types
- All domain CONTRACT.md files — to understand what data is available

## Interface Contract
See `CONTRACT.md` in this directory.

## Key Features to Build (Phase 2)
- NL project queries ("what shipped this week?")
- AI-generated executive summaries
- Automated changelogs and release notes
- Multi-audience dashboards (engineer / PM / exec views)
- Business-impact KPI linking
- SLA and compliance reporting
- AI-powered retrospectives
- Predictive sprint completion
- Usage and cost tracking (per-project, per-agent AI spend)

## Design Principles
- Reporting reads from other domains via their public APIs or the event log — never direct DB queries into other domain tables
- AI-generated content is always clearly labeled as AI-generated
- Cost data must be real-time accurate — never cached more than 5 minutes

## Do Not Build
- UI components (belongs in apps/desktop)
- Writing to non-reporting tables
