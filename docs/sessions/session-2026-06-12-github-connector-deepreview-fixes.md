# Session Log — 2026-06-12 — GitHub connector deepreview fixes

## What Was Done
- Fixed 4 completeness/correctness findings from the GitHub connector deepreview:
  1. `GitHubConnector.listResources` no longer truncates at 2 pages (200 repos) — pages of 100 until a short page, with a 10-page (1000-repo) runaway guard. Kept `affiliation=owner,collaborator,organization_member`.
  2. `GitHubProjectsClient.listProjects` now cursor-paginates every bucket: viewer projects (`first:100, after:$cursor`), the org list (`first:25, after:$orgCursor`), and follow-up `organization(login)` paging for orgs whose projects overflow their first page. 10-page guard per bucket.
  3. `fetchProjectSnapshot` resolves the status field up front: `field(name:"Status")` first, falling back to the FIRST `ProjectV2SingleSelectField` from `fields(first:30)` (renamed/localized fields). The resolved field NAME is passed to each item page's `fieldValueByName(name:$statusFieldName)` so item statuses follow the same field — not just the columns.
  4. `BaseConnector.fetchWithRetry` no longer misclassifies GitHub's 403 rate limits as fatal auth: 403 + `Retry-After` or `X-RateLimit-Remaining: 0` retries with backoff (Retry-After honored, capped 10s). Genuine 401/403 stay fatal.
- Updated/extended `github-projects.test.ts`: 63 tests (was 51) — projects pagination, org overflow follow-up, Status-field fallback (renamed + non-single-select cases), listResources >200 repos, 403 rate-limit retry vs fatal auth 403/401.

## Decisions Made
- Snapshot now does a small meta query first (project + status field), then pages items — one extra GraphQL request, but item statuses stay correct when the Status field is renamed (fieldValueByName is case-sensitive too, not just field(name:)).
- listProjects split into separate viewer/org queries to allow independent cursors; cross-owner shared projects remain the resolveProject/import-by-URL path (API cannot enumerate them).

## Files Created or Modified
- packages/integrations/src/connectors/base.ts
- packages/integrations/src/connectors/github.ts
- packages/integrations/src/connectors/github-projects.ts
- packages/integrations/src/connectors/github-projects.test.ts

## Open Questions
- None. Gate: typecheck clean, integrations suite 210/210 green.

## Next Session Should Start With
- Nothing pending for this task; PROGRESS.md "RESUME HERE" still points at merging `feat/claude-cli-membership-provider` to main.
