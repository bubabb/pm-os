# Domain: Integrations
---
status: active
version: 1.0
last-updated: 2026-06-03
---

## What This Domain Does
The external connectivity layer. Fetches, normalizes, and caches data from external DevOps and productivity tools (Jira, GitHub, Confluence, Notion, OneDrive). Owns the background sync engine, OAuth credential management, cross-source entity correlation, and the two-stage PM action classifier. Domain 5 (Reporting) reads from this domain — it never calls external APIs directly.

## Your Task Instructions
Read `/docs/agents/tasks/` for the specific task file assigned to this session.

## Files You Own
- `packages/integrations/src/**`

## Files You Read (Never Edit)
- `packages/database/src/schema.ts` — DB schema
- `packages/shared/src/**` — shared types
- All domain CONTRACT.md files — to understand what data is available
- `apps/desktop/src/main/secrets/index.ts` — for `getIntegrationToken()` (never decrypt tokens yourself)

## Interface Contract
See `CONTRACT.md` in this directory.

## Key Features to Build (Phase 2)
- Source connectors: Jira (MCP), GitHub (MCP), Confluence (REST), Notion (REST), OneDrive (Microsoft Graph)
- Background sync engine — 15-min polling, cursor-based pagination, sync state management
- External event normalization — unified entity schema across all sources
- Cross-source entity correlation — Jira ↔ GitHub ticket ID matching (MVP); extensible to full graph
- Two-stage PM action classifier — rule engine first, LLM fallback for ambiguous cases
- PM digest generation — morning_brief, sprint_health, decisions_and_docs, risk_radar
- Integration health monitoring — sync errors, credential expiry alerts

## Design Principles
- This domain fetches and normalizes — it never renders UI or executes agent tasks
- All OAuth tokens must be fetched via `getIntegrationToken()` from the secrets layer — never store plaintext tokens anywhere in this package
- External API calls must always be wrapped with retry logic and exponential backoff
- The classifier output (`{ bucket, urgency, riskType, suggestedAction }`) is the contract with Domain 5 — never change the shape without updating CONTRACT.md
- Cross-source correlation is best-effort — a missed link is acceptable; a false link is not

## Do Not Build
- UI components (belongs in apps/desktop)
- Agent task execution (belongs in Domain 1: agent-orchestration)
- Anything that writes to non-integrations tables except via the event log
