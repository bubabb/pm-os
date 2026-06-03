# Session Log — 2026-06-03 — Domain 6 Integrations & PM Dashboard Design

## What Was Done
- Scoped the PM Command Center dashboard use case (Jira + GitHub + Confluence + Notion + OneDrive aggregation for PM daily triage)
- Ran full 3-pass design review — identified 4 critical architectural problems in the original design: missing domain, schema gaps, domain boundary violations, Agent Activity duplicating Observability
- Added Domain 6: Integrations to project-scope.md (v1.3) — external connectors, OAuth credential store, sync engine, cross-source entity correlation, two-stage PM classifier, PM digest generation
- Bumped schema to v1.2.0 — added 5 new tables: `integration_credentials`, `integration_sync_state`, `external_event_cache`, `pm_digest_cache`, `user_settings`
- Added 4 new indexes for the integration tables in data-models.md
- Updated Phase 1 Task #4 to include `integration-credentials-service.ts` — OAuth token storage using same AES-256-GCM encryption as internal secrets
- Created `packages/integrations/CLAUDE.md` and `CONTRACT.md` — Domain 6 package scaffold
- Created `agent-state/domain-state/integrations.md`
- Updated root `CLAUDE.md` monorepo structure to include Domain 6
- Updated Phase 2 build order in project-scope.md: Domain 6 first, then Domain 5 (PM Command Center), then Domains 1–4 in parallel

## Decisions Made
- **Domain 6 is a prerequisite for the PM dashboard** — Domain 5 (Reporting) reads normalized data; it never calls external APIs directly. Clean separation.
- **Delegate panel routes to Domain 1** — agent task execution is Domain 1's responsibility; the dashboard UI is just a trigger surface
- **Agent Activity panel consumes Domain 3** — no separate data layer; PM dashboard reads from Observability's public API
- **external_event_cache is append-only with soft-delete** — new fetch = new row; TTL purging uses `purgedAt`, never hard DELETE (consistent with append-only event log philosophy)
- **user_settings requires projectId in v1** — global settings deferred to v2 to avoid NULL uniqueness issues in SQLite unique indexes
- **integration_credentials uses same encryption as secrets** — AES-256-GCM, IV per encryption, key from Electron safeStorage. OAuth tokens are secrets.
- **PM Command Center is Domain 5's first Phase 2 deliverable** — concrete user story, real validation of Creare's stakeholder intelligence pillar

## Files Created or Modified
- `/Users/bubagv/Desktop/devops_platform/project-scope.md` — v1.3, Domain 6 added, Phase 2 build order updated
- `/Users/bubagv/Desktop/devops_platform/packages/database/src/schema.ts` — 5 new tables, 4 new indexes, SCHEMA_VERSION 1.2.0
- `/Users/bubagv/Desktop/devops_platform/docs/architecture/data-models.md` — v1.2, integration tables and indexes documented
- `/Users/bubagv/Desktop/devops_platform/docs/agents/tasks/phase1-task4-auth-rbac-secrets.md` — integration-credentials-service added, Done When checklist updated
- `/Users/bubagv/Desktop/devops_platform/CLAUDE.md` — Domain 6 added to monorepo structure
- `/Users/bubagv/Desktop/devops_platform/packages/integrations/CLAUDE.md` — created
- `/Users/bubagv/Desktop/devops_platform/packages/integrations/CONTRACT.md` — created
- `/Users/bubagv/Desktop/devops_platform/agent-state/domain-state/integrations.md` — created

## Open Questions
- Should Jira and GitHub use MCP servers in Phase 2, or fall back to REST if MCP server quality is inconsistent?
- Does the PM want calendar integration (meetings today on the context strip)? Not scoped yet — likely Microsoft Graph or Google Calendar API via Domain 6.
- Rate limiting strategy for external API calls during sync — exponential backoff spec not written yet.

## Next Session Should Start With
Begin Phase 1: run Task #4 (auth/secrets including integration-credentials-service) and Task #5 (DB/API) in parallel. Task #4 now has an expanded scope — the integration-credentials-service is new. Schema is at v1.2.0 and includes all integration tables.
