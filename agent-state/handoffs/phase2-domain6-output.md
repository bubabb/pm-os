# Handoff: Phase 2 — Domain 6: Integrations + AI SDK

**Status:** Complete  
**Completed:** 2026-06-03

## What Was Built

### @pm-os/ai-sdk
- `src/types.ts` — CompletionRequest, CompletionResponse, Message, ModelProvider
- `src/providers/anthropic.ts` — Anthropic SDK wrapper with per-model cost calculation (Sonnet/Opus/Haiku)
- `src/index.ts` — `complete(request, apiKey)` — provider-routing public API

### @pm-os/integrations — Domain 6
- `src/types.ts` — IntegrationSource, NormalizedEntity, ClassifiedItem, SyncStatus, ConnectorConfig, FetchResult
- `src/connectors/base.ts` — BaseConnector abstract class with 3-attempt exponential backoff fetchWithRetry
- `src/connectors/github.ts` — GitHub REST API, open PRs + issues, extracts Jira ticket IDs for correlation
- `src/connectors/jira.ts` — Jira Cloud REST API v3, JQL assigned/open issues with cursor pagination
- `src/connectors/confluence.ts` — Confluence Cloud REST API v2, recently modified pages
- `src/connectors/notion.ts` — Notion API, database query with cursor pagination
- `src/connectors/onedrive.ts` — Microsoft Graph, /me/drive/recent files
- `src/normalizer.ts` — `toExternalEventCacheRow()` maps NormalizedEntity → DB insert shape
- `src/sync-engine.ts` — `sync(credential, token)` — full sync lifecycle: soft-purge stale, fetch pages, write cache, update sync state, emit events
- `src/correlator.ts` — `correlateEntities()` — Jira↔GitHub cross-source link via ticket ID extraction
- `src/classifier.ts` — `classifyItems()` — Stage 1 rule engine (no LLM), Stage 2 Haiku LLM for ambiguous items
- `src/digest-generator.ts` — `generateDigest()` + `getLatestDigest()` — 15-min TTL PM digest cache, four digest types
- `src/index.ts` — full public API matching CONTRACT.md

### Desktop app
- `src/main/routes/integrations.ts` — 6 routes: list/create/delete credentials, trigger sync, get status, get events
- `@pm-os/integrations` added to desktop app dependencies

## Token Injection Pattern
`packages/integrations` does NOT import from `apps/desktop` — no circular dep.
The desktop routes fetch tokens via `getIntegrationToken()` and pass them as parameters to `triggerSync()`.
All connectors receive tokens as constructor arguments.

## Key Design Decisions
- Sync is fire-and-forget (POST /sync returns immediately, sync runs async)
- Soft-purge via `purgedAt` — never hard DELETE from external_event_cache
- LLM classifier uses Haiku (cheapest) — Sonnet only for digest generation
- Correlator is best-effort: false negatives OK, false positives not acceptable — verified by JSON parse after LIKE match

## For Domain 5 (PM Command Center)
Use `getActiveEvents(projectId)` then `classifyItems(projectId, rows, apiKey)` to get ClassifiedItem[].
Use `generatePmDigest()` or `getLatestDigest()` for cached AI-generated summaries.
API key must be fetched from the secrets service by the desktop app and passed through.
