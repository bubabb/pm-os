# Creare Bidirectional Sync — Architecture Blueprint

> Designed 2026-06-11 (Fable 5 architecture pass). The plan to turn Creare from a
> read-only integration layer into a two-way management platform ("Azure DevOps but
> better"): connect an account, mirror a remote board/project, and manage it from
> Creare with git-pull/push-style two-way sync. This doc is the build spec; Phase 1
> is executed first.

## Decision
**Mirrored boards + durable push outbox + three-way pull reconciliation.**
- Creare's existing Kanban becomes the editor; a Creare `board` links to one remote
  board (GitHub Projects v2 first). Columns mirror remote status options; cards mirror
  remote items (each backed by a real `task`, since `board_items.taskId` is NOT NULL —
  remote items become agent-assignable Creare tasks).
- **Push** = durable `mutation_queue` outbox; local change applies instantly, a
  main-process worker drains FIFO per credential (the "git push").
- **Pull** = snapshot + three-way diff against a `remote_links` shadow table holding
  `remoteVersion` + `lastSyncedHash` (the "git pull"); base/local/remote = conflict
  detection.
- Domain ownership preserved: integrations owns connectors/GraphQL/outbox/reconciler;
  it writes boards tables ONLY via a new `@creare/boards.applyMirrorSnapshot()` API.
- The existing read-only pipeline (`external_event_cache`, classifier, digests) is
  untouched — mirror sync is a parallel pipeline.

## New schema (additive migration 0007, SCHEMA_VERSION → 1.8.0)
- `remote_links` — local entity ↔ remote entity mapping + `remote_version` +
  `last_synced_hash` (3-way merge base) + soft `deleted_at`.
- `mutation_queue` — push outbox: `op_id` (idempotency), `kind`, JSON `payload`,
  `base_version`, `status` (pending|in_flight|applied|conflict|failed|cancelled),
  `attempts`, `result`.
- `sync_conflicts` — base/local/remote snapshots + resolution, surfaced to UI.
All emit append-only `events` rows on every transition (audit convention kept).

## Connector write surface (BaseConnector additions)
- `capabilities: { write: MutationKind[] }` (default `[]` = read-only).
- `applyMutation(envelope: MutationEnvelope): Promise<MutationResult>`.
- `fetchRemoteVersion(ref): Promise<string|null>` (cheap pre-push conflict probe).
- `verifyWriteAccess(): 'read_write'|'read_only'|'unknown'` (Connections badge).
- Normalized `MutationOp` discriminated union: move_item / create_item / update_item /
  comment / close_item / reopen_item / archive_item.

## Capability matrix (per connector) and version source for conflict detection
GitHub issues/PRs (REST) · GitHub **Projects v2 (GraphQL)** · Jira (transitions) ·
Confluence (`version.number` server-locking) · Notion · OneDrive (`eTag`/`If-Match`).
See the per-op table in the design discussion. Version source: GitHub `updatedAt`,
Jira `fields.updated`, Confluence `version.number`, Notion `last_edited_time`,
OneDrive `eTag`.

## GitHub Projects v2 (flagship) — GraphQL
- `POST https://api.github.com/graphql`, Bearer token (same as github.ts).
- Queries: list viewer+org projects; project snapshot (fields + Status single-select
  options + items with `fieldValueByName("Status")` + content Issue/PR/DraftIssue).
- Mutations: `updateProjectV2ItemFieldValue` (move = set Status single-select — the
  Phase 1 write), `addProjectV2ItemById`, `addProjectV2DraftIssue`,
  `archiveProjectV2Item`.
- Scopes: classic PAT `project` + `repo` (recommended); fine-grained = Projects RW +
  Issues RW + Metadata R (support historically lags → recommend classic, badge `unknown`).
- Mapping: ProjectV2→board, Status options→columns (order=position, done-ish/last=terminal),
  items→board_items+tasks, no-status→synthetic first column.
- Rate limits: GraphQL 5000 pts/hr (snapshot ≈ negligible); real limit is secondary
  (~2000 pts/min, NO concurrent mutations per token, ~80 content writes/min) → outbox
  serial per credential, ≥500ms spacing, honor Retry-After/RATE_LIMITED.

## Reconciliation (pull) and outbox (push)
- Pull: snapshot → per item lookup in `remote_links`: no link→create; hash unchanged→skip;
  remote changed & local==base & no pending op→apply remote→local; remote changed & (pending
  op or local diverged)→conflict; missing remotely→archive local + soft-delete link. All
  local writes via `boards.applyMirrorSnapshot()` in one transaction.
- Push: drag → local PATCH applies → if item has a link, `enqueueMutation` (base_version =
  link.remote_version) → worker drains FIFO single-flight per credential: version probe; if
  changed and op is conflict-sensitive → conflict; else applyMutation → update link. Retries
  with backoff, max 5 → failed + notification. Failed pushes surfaced (like a rejected push),
  never auto-rolled-back.
- Conflict policy: move_item = last-write-wins (push anyway, log overwroteRemote); edits/close
  = pause + prompt (Keep mine / Take theirs).

## Phased roadmap
- **Phase 1 — GitHub Projects v2 two-way mirror** (proving slice): import a Project as a
  mirrored board, pull (items/columns/status), push card moves. move_item is idempotent +
  single-field → smallest conflict surface, but exercises every new subsystem.
- **Phase 2** — GitHub item lifecycle (create/update/close/comment) + conflict-resolution UI.
- **Phase 3** — Jira two-way (statuses-by-category columns, moves via transitions).
- **Phase 4** — Notion + Confluence + OneDrive writes.
- **Phase 5** — hardening: delta pulls, webhooks via relay, agent mutations through
  approval_gates, bulk ops, queue compaction, background pull scheduler.

## Phase 1 build (11 new + 5 modified files)
New: migration 0007 + schema tables; `packages/shared/src/hash.ts` (stableHash);
integrations `types.ts` mirror types; `connectors/github-projects.ts` (GitHubProjectsClient);
`mirror/reconciler.ts` (pure planReconcile + tests); `mirror/mirror-sync.ts`
(createMirror/pullMirror/getMirrorStatus); `mirror/outbox.ts` (enqueue/drain/enqueueBoardItemMove);
`routes/mirrors.ts`; `sync/push-worker.ts`; renderer `ImportRemoteBoardDialog.tsx` +
`MirrorStatusChip.tsx`; tests.
Modified: `connectors/base.ts` (+write surface), `connectors/github.ts` (+overrides),
`boards/src/index.ts` (+applyMirrorSnapshot writing boards+remote_links), `routes/boards.ts`
(PATCH hook → enqueueBoardItemMove + kickPushWorker), BoardsPage.tsx (+Import button, chip,
pull on mount/interval), main bootstrap (startPushWorker), both CONTRACT.md + GLOSSARY.

Build order: schema → shared hash → integrations types → BaseConnector → GitHubProjectsClient →
GitHubConnector overrides → reconciler → boards.applyMirrorSnapshot → mirror-sync → outbox →
routes + push-worker + bootstrap → renderer → CONTRACT/GLOSSARY → full gate + manual PAT smoke.

## Phase 1 acceptance
Import a real GH Project → correct columns+cards; drag a card → GitHub reflects within ~5s
(+events enqueued/applied); move on github.com → next pull moves it locally without disturbing
others; move both sides → LWW push wins (overwroteRemote logged); network kill mid-push → op
stays pending, retries, succeeds; revoke scope → op failed + notification + read-only banner.
