# Session Log — 2026-06-12 — Resolve/import GitHub Project (v2) by URL

## What Was Done
- Added cross-owner GitHub Project resolution: a token can access OTHER users'/orgs' projects it collaborates on, which the viewer-scoped `listRemoteBoards` never surfaces.
- `github-projects.ts`: new exported `parseProjectUrl()` (users/orgs project URLs → `{ login, number, ownerType }`, null on anything else) and `GitHubProjectsClient.resolveProject(login, number)` (GraphQL `user(login){projectV2(number)}` with `organization(login)` fallback; NOT_FOUND → null, scope/auth/rate-limit errors throw).
- `base.ts`: `resolveRemoteBoard(_ref)` default returning null on `BaseConnector`.
- `github.ts`: `GitHubConnector.resolveRemoteBoard(ref)` override — parse URL, resolve via client.
- `mirror-sync.ts` + `index.ts`: exported `resolveRemoteBoard(source, config, ref)` (buildConnector dispatch).
- `routes/mirrors.ts`: new `GET /connections/:connectionId/resolve-board?ref=<url>` (requireAuth). 200 → RemoteBoardOption; 400 missing ref; 404 connection missing OR project unresolvable (collaborator hint message); 502 upstream failure. Factored the duplicated connection→ConnectorConfig construction into `connectionConnectorConfig()` shared with the remote-boards route.
- Tests: 12 new cases in `github-projects.test.ts` (URL parse matrix, user-found, org fallback ×2, not-found→null, scope error propagation, connector URL-parse short-circuit). Suite now 53/53.

## Decisions Made
- Bare project numbers are rejected — cross-owner import requires a full URL (a bare `#2` is ambiguous about the owner).
- `resolveProject` tries `user(login)` then `organization(login)` regardless of the URL's `ownerType` — robust to users pasting the wrong form; GraphQL NOT_FOUND on the user query is a fallback signal, not an error.
- 404 (not 422) for "token cannot see it": GitHub does not distinguish missing from no-access.
- No change to `POST /projects/:id/mirrors` — the UI feeds the resolved `id` into the existing route.

## Files Created or Modified
- packages/integrations/src/connectors/github-projects.ts
- packages/integrations/src/connectors/github-projects.test.ts
- packages/integrations/src/connectors/base.ts
- packages/integrations/src/connectors/github.ts
- packages/integrations/src/mirror/mirror-sync.ts
- packages/integrations/src/index.ts
- apps/desktop/src/main/routes/mirrors.ts

## Open Questions
- UI for the "paste a project URL" input (renderer) is not built yet — only the backend surface exists.
- Other connectors (Jira boards, Notion databases) inherit the null default for `resolveRemoteBoard`; implement per-source parsers later.

## Next Session Should Start With
- Wire the renderer mirror-import picker to GET `/connections/:connectionId/resolve-board?ref=` and feed the resolved id into POST `/projects/:id/mirrors`.

## Verification
- `pnpm --filter @pm-os/integrations build` ✓, `typecheck` ✓, `pnpm --filter @pm-os/desktop typecheck` ✓, `pnpm vitest run packages/integrations/src/connectors/github-projects.test.ts` 53/53 ✓, eslint (both packages) ✓.
