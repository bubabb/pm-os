# Creare — PROGRESS

At-a-glance resume snapshot. **Read this first** when picking the project back up.
This is the current-state pointer; the append-only detail log is
`agent-state/agent-log.md`, per-domain state is `agent-state/domain-state/`,
and cross-task handoffs are `agent-state/handoffs/`.

**Updated:** 2026-06-11

---

## STATUS NOW
- **RESUME HERE (2026-06-12, NEWEST):** **All-connector access + correctness fixes, UI crash/focus fixes, import-by-URL.**
  Gate GREEN: typecheck 23/23 · unit **293/293** · lint 12/12 · desktop real `tsc -b`. `main`, 77 commits, no GitHub remote yet.
  • **Connector access (owned + shared/invited) + correctness deepreview (commit `f7aa17c`):** OneDrive now lists
    **shared-with-me** (was own-drive only) + real folder scoping; all listings paginate fully (were capped 100-200).
    **Jira P0:** migrated `/rest/api/3/search` (REMOVED from Jira Cloud → was silently syncing 0) → `/search/jql` w/
    nextPageToken. **Confluence P0:** fixed broken pagination cursor (was syncing only ~25 items) + archive endpoint.
    GitHub: repo list no longer 200-capped (affiliation already covers collaborator/org/invited), Projects list
    paginates, Status-field fallback, 403-rate-limit retry. Jira JQL quoting + Done-transition pick. +41 tests.
  • **Import a GitHub Project by URL** (commit earlier today): `resolveRemoteBoard` + `GET /connections/:id/resolve-board`
    + dialog input — for cross-owner projects the viewer-scoped list can't show (GitHub has no "shared projects" API).
    VERIFIED LIVE: bubabb token resolves `rsemnani/projects/2`.
  • **UI fixes:** inputs no longer lose focus after one char (Dialog focus-trap effect depended on inline onClose →
    fixed deps `[open]`+ref; DelegateConfigDrawer same); "View synced items" crash (events route returned raw cache
    rows w/ payload-nested fields → UI read them top-level → threw → blanked app) → route normalizes + **new root
    ErrorBoundary** so a render crash shows a recoverable card, never a blank screen.
  • **VERIFIED LIVE on Kali (real app, port 4321):** token re-add works (stable key), GitHub source sync (12 issues
    from rsemnani/DeepLearningCapstone), GitHub Projects import (board+columns), import-by-URL resolves rsemnani/projects/2.
  • **NOT live-verified:** Jira/Confluence/Notion/OneDrive write+mirror round-trips (mocked tests only — need real
    tenants); the packaged installer (electron-builder config exists, needs a real per-OS build machine).
- **(prior) 2026-06-11: Card-lifecycle on buttons + whole-project production deepreview + hardening + packaging path.** Gate GREEN: typecheck 23/23 · unit **240/240** · lint 12/12 · desktop real `tsc -b`.
  • **Every action on a button:** New card / Edit title / Close / Comment on mirrored boards push to GitHub/Jira/Notion
    (outbox enqueueItemCreate/Update/Close/Comment; create links the remote id on push success). Renderer↔backend
    wiring verified 100% matched (no dead buttons/routes).
  • **8-reviewer production deepreview** (commit `f424fa9` fixes, `2e32414` packaging). FIXED: Electron lifecycle
    (single-instance lock, macOS close→reopen no longer wedges the backend, boot try/catch→error dialog); SQLite
    `busy_timeout`+integrity_check+resourcesPath migrations; **credential-delete FK trap** (was a 500 making it
    undeletable → transactional cascade) + **cross-project IDOR** on credential-delete & conflict-resolve; pull/status
    filter tombstoned mirrors; create_item pending count; Tools/Observability/PMCommandCenter silent-failure → toasts/
    QueryError/Retry; **retention prune** (events 90d / applied-mutations 14d / resolved-conflicts 30d / read-notifs 30d).
  • **Packaging:** `electron-builder.yml` (AppImage/deb/dmg/nsis, asarUnpack native, migrations via extraResources) +
    `pnpm package`/`package:dir`; electron-vite now BUNDLES `@creare/*` into the main bundle (was unpackable symlinks),
    better-sqlite3 stays external. Built bundle boots (Fastify+migrations verified).
  • **REMAINING for true 100%-shippable (honest):** (1) **run `electron-builder` on a real per-OS machine** (network+
    signing) to produce+launch a signed installer — UNVERIFIABLE in this sandbox; (2) **live-verify the whole app in a
    real GUI** (Electron won't launch headless here) — esp. real GitHub/Jira/Notion two-way round-trips (all connector
    tests are mocked-fetch); (3) **security posture disclosure** — master/JWT key is raw base64 in `keys.json` (0600)
    beside the ciphertext DB: stable + atomic + loud-on-rekey, but NOT "encrypted at rest" in a keyring sense (deliberate
    local-first trade-off — document, don't oversell); (4) deferred P2s: agent EXECUTION runtime still unbuilt, mirrors
    don't auto-pull (manual only), SSE doesn't re-auth on token expiry, renderer hardcodes :4321, classifier/digest
    event-log gaps, a11y tablist roles, native confirm() dialogs. Full findings in the 8 session logs `docs/sessions/session-2026-06-11-*`.
  Full gate GREEN: typecheck 23/23 · unit **227/227** · lint 12/12 (desktop typecheck is now a REAL `tsc -b`).
  • **Generic mirror engine** — BaseConnector `listRemoteBoards`/`fetchBoardSnapshot`; mirror-sync builds the
    connector by source (no hardcoded GitHub). **Conflict resolution** shipped: `mirror/conflicts.ts`
    (listOpenConflicts/resolveConflict local_wins/remote_wins/dismiss), `routes/conflicts.ts`, `ConflictsDrawer.tsx`
    + clickable chip badges (conflicts + failedPushes).
  • **All 5 connectors have WRITE surfaces (tested, mocked-fetch):** GitHub full lifecycle (move/create-draft/update/
    close=archive/reopen/comment); **Jira two-way** (board mirror; move via workflow TRANSITIONS w/ fatal-on-no-legal-
    transition; create/update/comment/close); **Notion two-way** (database mirror; status/select prop→columns;
    move/create/update/archive/comment; statusFieldRemoteId='type:propName'); **Confluence** (update w/ version-lock,
    comment, archive); **OneDrive** (rename, move, If-Match eTag).
  • **Import dialog + status chip generalized** to GitHub/Jira/Notion → import→pull→drag-to-move is two-way for all
    three. (Confluence/OneDrive are item-level, no board mirror.)
  • **NOT YET WIRED (remaining tail):** card-LIFECYCLE UI — create/edit/close/comment a card FROM Creare and push it
    (connector supports all of it; only MOVE is wired UI→push so far). Needs generic board-card-action routes +
    UI affordances on mirrored boards. Confluence/OneDrive writes have no UI surface yet. **Still NOT live-verified**
    (Electron won't launch in agent sandbox) — verify in `pnpm dev`. Pull-side conflicts persist + show, but the
    self-echo `lastSyncedHash` (benign, converges) and remote-column-deletion handling remain deferred.
- **NEXT:** generic card-lifecycle actions (create/edit/close/comment → enqueue → push) across mirrored boards;
  then live-verify in `pnpm dev`. Design+roadmap: `docs/architecture/bidirectional-sync.md`.
- **(prior) Phase 1 ADVERSARIAL DEEPREVIEW + PRODUCTION-HARDENING DONE on `main`**
  (commits `6564e08` correctness/security, `e65a5b9` real-typecheck). 5 Fable 5 reviewers ran Ground→Verify→Break-it;
  ~10 fixes landed. **Gate now GENUINELY green: typecheck 23/23 · unit 151/151 · lint 12/12.**
  • **BIGGEST FINDING — desktop typecheck was VACUOUS:** `tsc --noEmit` on a solution tsconfig (`files:[]`) checked
    NOTHING, so the renderer was never type-checked and **`@types/react` wasn't even installed** (every React import
    was silently `any`). Fixed: script → `tsc -b --noEmit`, added `@types/react(-dom)`, fixed the 18 real errors it
    surfaced. **`apps/desktop` typecheck = `tsc -b --noEmit` now — do NOT revert to `tsc --noEmit`.**
  • **Correctness fixes (silent-data-loss):** failed/conflicted ops now count as divergence (no silent move-revert);
    `enqueueBoardItemMove` never throws (records a tracked failed row); `recoverStaleInFlight()` at boot (crash
    recovery); boards PATCH awaits enqueue; pull conflicts persisted to `sync_conflicts`; `getMirrorStatus.failedPushes`;
    push-worker notifies on failures; duplicate-import 409 guard + credential cleanup; mirrored task writes now emit
    events; link lookups scoped by containerRemoteId (**migration 0008**); local deletes tombstone links.
  • **Security:** atomic `keys.json` write (temp+rename); loud-warn-not-silent on re-key when ciphertext exists;
    JWT no longer in dev logs.
  • **Still NOT live-verified** (Electron won't launch in agent sandbox) — verify in `pnpm dev`. **STILL OUTSTANDING
    from review (defer to Phase 2): conflict-resolution UI** (sync_conflicts now populated + chip shows counts, but the
    badge links nowhere — build the review/resolve surface in Phase 2); remote-column-deletion handling; failedPushes
    not yet rendered on the chip.
- **NEXT: Phase 2 (GitHub item lifecycle: create/edit/close/comment + conflict-resolution UI) then Phase 3 (Jira
  two-way).** Build on the now-hardened foundation, review-as-you-go. Design+roadmap: `docs/architecture/bidirectional-sync.md`.
- **(prior) BIDIRECTIONAL SYNC — Phase 1 CODE-COMPLETE on `main`** (commits
  `9d846e4` foundation, `61b3c44` engine, `660ac08` mirror engine, `7c99ffc` wiring/UI). Built from
  `docs/architecture/bidirectional-sync.md` (Fable 5 design) in 4 verified waves of parallel Fable 5 agents.
  Full gate GREEN: typecheck **23/23** · unit **131/131** · lint **12/12**. **NOT yet verified live** — the real
  GraphQL flow needs a real GitHub Project + a classic PAT with `project`+`repo` scopes, and Electron won't launch
  in the agent sandbox; verify in `pnpm dev`.
  • **What Phase 1 delivers:** "Import from GitHub" on the Boards page → pick a connection + a **GitHub Project (v2)**
    → it becomes a mirrored Creare Kanban (columns = Status options, cards = items backed by tasks). **Drag a card →
    pushes the move back to GitHub** (durable outbox, FIFO per credential, LWW for moves). **"Pull now"** reconciles
    remote→local (three-way diff vs `remote_links` shadow table; conflicts counted). move_item only in P1.
  • **New:** migration `0007` (SCHEMA_VERSION **1.8.0**: `remote_links`, `mutation_queue`, `sync_conflicts`);
    `@creare/shared.stableHash`; connector write surface (`capabilities`/`applyMutation`/`fetchRemoteVersion`/
    `verifyWriteAccess`); `GitHubProjectsClient` (GraphQL); `mirror/{reconciler,mirror-sync,outbox}`;
    `boards.applyMirrorSnapshot` (plain `MirrorApply` contract — boards never imports integrations, no cycle);
    `routes/mirrors.ts` + `sync/push-worker.ts`; renderer `ImportRemoteBoardDialog` + `MirrorStatusChip`.
  • **remote_links convention:** board link `containerRemoteId` = Status FIELD id; column/item links
    `containerRemoteId` = ProjectV2 node id. Auto-pull deferred to manual "Pull now" (avoid mid-drag conflicts).
  • **Roadmap (docs/architecture/bidirectional-sync.md):** P2 = GH item create/edit/close/comment + conflict-resolution
    UI; P3 = Jira two-way (moves via transitions); P4 = Notion/Confluence/OneDrive writes; P5 = delta/webhooks/agent
    mutations via approval_gates.
- **Earlier 2026-06-11 fixes (all on `main`):** key-rotation root-cause fix (stable raw master/JWT keys, never rotate
  on a keyring hiccup — `68803bc`); claude-cli provider can't crash the host (stdin EPIPE — `cdea9ba`); undecryptable
  global setting degrades to default not a 500 (`5043999`); resource-picker surfaces the real error (`0709c06`).
  **Token gotcha:** a token encrypted BEFORE the stable-key fix is orphaned (unrecoverable) — re-add it ONCE via
  Connections; it then persists forever.
- **(prior) big INTEGRATION REVISION landed on `main`** (commits `14b1b3a` wave1, `8394a55`
  wave2; tree clean). Driven by user feedback "tabs/data don't communicate, looks like a static app." Ran a Fable 5
  3-reviewer deep review → executed in 2 waves of 5 parallel Fable 5 agents. Static gate GREEN (typecheck 23/23 ·
  unit 81/81 · lint 12/12). **E2E COULD NOT RUN — tool sandbox kills Electron (exit 144); verify live in `pnpm dev`.**
  Session log: `docs/sessions/session-2026-06-11-integration-revision.md`. Highlights:
  • **Data now flows visibly:** auto-sync on source add; `POST /integrations/bulk` (multi-select repos/projects for
    every connector — no schema change, per-row); GET list enriched w/ lastSyncedAt/syncStatus/syncError; GitHub
    connector throws clear error on repo 404; dashboard 3 honest states (no sources / connected-but-unsynced / data)
    via `integrations{connectedCount,syncedItemCount,lastSyncedAt}`; Settings sync-feedback loop (poll /status→toast)
    + browsable "synced items" view; `syncAndRefresh` in dashboard store.
  • **Tabs wired together:** Boards "+ Add task" per column (Kanban can hold cards now); Delegate honest copy + "View
    in Agents" + invalidates tasks/timeline; Risk "Handle it"→real human task; ack/dismiss persist (localStorage);
    notifications have REAL producers (delegate, source-bound) so the bell lights up + rows deep-link; AgentsPage
    honest Start/Pause (no fake exec) + gate-resolve refreshes tasks; Observability/Intelligence honest empty states
    + cross-links + a real "Run smoke suite" eval CTA.
  • **Known:** user's repo `bubabb/theantidote` likely has no OPEN issues/PRs → legitimately syncs 0 items; UI now
    says so. Token-encryption fragility (safeStorage key rotation orphaned a token; re-adding fixed it) — hardening offered+deferred.
- **(prior) everything MERGED TO `main`** (fast-forward; was `main` @ `da36a4c`).
  No GitHub remote. Membership/claude-cli provider + the PM-UX overhaul are all on `main`, full gate GREEN
  (typecheck **23/23** · unit **81/81** · lint **12/12** · E2E **2/2**). `feat/claude-cli-membership-provider`
  branch can be deleted (fully merged). Optional next: verify `CREDENTIAL_SERVICE` on Mac/Windows (`pnpm check:auth`).
- **PM-UX overhaul + connections resource picker (2026-06-11, Fable 5 via 8 parallel subagents): DONE, on `main`.**
  Session log: `docs/sessions/session-2026-06-11-pm-ux-overhaul.md`. Grounded Fable 5 deepreview (20 findings) →
  executed P0→P2 in two disjoint-file waves. Commits `7a2449d`/`5d1c0b4`/`8f592fb`/`da36a4c`.
  • **Connections fix (the ask):** every connector now has `listResources()` + `GET /connections/:id/resources`;
    Settings→Sources shows a **searchable resource picker** (GitHub repos via `affiliation=owner,collaborator,
    organization_member` = public/private/**invited**; Jira projects, Confluence spaces, Notion DBs, OneDrive
    folders), with manual-entry fallback on 502/empty. (Decision: keep PAT, not OAuth — local-first, no server to
    hold a client secret. Picker generalizes to all/future connectors.)
  • **Project lifecycle real:** `?archived=1` listing + `POST /projects/:id/restore` (archive→**restore now works**),
    hardened/validated create+PATCH, and **template scaffolding actually runs** (ai-tool→board+workspace,
    agent-pipeline→workspace+3-task DAG, blank→none; best-effort).
  • **Top-1% renderer:** in-house (no new deps) shared UI — `Dialog` (a11y focus-trap), `Toast` (`toast.*` +
    `ToastViewport` in App.tsx), `CommandPalette` (Cmd/Ctrl+K), `EmptyState`/`NoProject`, `Spinner`, `lib/format`.
    `ProjectList` rebuilt (guarded create, avatars/favorites/filter, loading/error, Archived+Restore). `AppShell`
    **in-place project switcher** popover (no nav away) + palette + breadcrumb + collapsed tooltips + Settings in nav.
    `Settings` editable rename + the resource picker. `BoardsPage` native HTML5 **Kanban drag-and-drop** (optimistic,
    dropdown kept as a11y fallback). Project color/emoji/favorites are client-side (localStorage) — no schema change.
  • **E2E gotcha:** kill stray `out/main/index.js`/preview procs before E2E — a leftover holding port 4321 makes the
    app fail to boot (`EADDRINUSE :4321`), which looks like a code break but isn't.
- **(superseded) RESUME HERE (2026-06-11 EOD):** membership/claude-cli feature COMPLETE + TESTED on
  `feat/claude-cli-membership-provider` (9 commits) — now merged to `main` (see above).
  Session log: `docs/sessions/session-2026-06-11-claude-cli-provider.md` (parts 1–7).
- **Membership testing spin (2026-06-11, Opus 4.8): DONE.** Full gate GREEN — lint clean · typecheck clean ·
    unit **81/81** · **E2E 2/2**. Commits `3f1c4f0` (fix) + `e7037a2` (test+chore) on the same feature branch.
  • **REAL BUG found + fixed:** the claude-cli/membership model wraps its "JSON only" output in a ```json fence,
    so the classifier's bare `JSON.parse` threw and every ambiguous item silently fell back to human/urgency-3.
    Added `extractJson()` to ai-sdk (strips ```json/``` fences + recovers a {…}/[…] span from prose); classifier
    now uses it. Verified live against the membership model. +6 extractJson tests, +1 classifier fenced case.
  • **New E2E** `apps/desktop/e2e/membership.spec.ts` — drives the real Electron app → Connections → asserts the
    live "Signed in" membership badge (renderer → Fastify `/settings/claude-cli-health` → checkClaudeCli → real
    credential store) + the claude-cli "(membership)" reasoning models. (E2E needs Electron ABI: run `pnpm e2e`,
    not `playwright test` directly, after `pnpm test` — `pnpm test` swaps better-sqlite3 to the Node ABI.)
  • **Lint debt cleared:** 12 pre-existing `no-unused-vars` errors fixed (eslint config now ignores `_`-prefixed
    vars/destructures; dropped a handful of unused imports; `get`→`_get`). Lint is green for the first time.
- **Membership/claude-cli provider (2026-06-11, Opus 4.8): DONE.** typecheck clean · tests **74/74** · build clean.
  **Committed locally** on branch `feat/claude-cli-membership-provider` (commit `4d5c223`); NOT merged to `main`,
  NOT pushed (no GitHub remote yet). Session log: `docs/sessions/session-2026-06-11-claude-cli-provider.md`.
  • **New `claude-cli` provider** in `ai-sdk` — uses the Claude **membership** (local CLI login), NOT an API key.
    Shells out to `claude -p --output-format json --model <m> [--append-system-prompt]`, stdin = rendered prompt;
    maps `result`/`usage`/`total_cost_usd` → CompletionResponse (costCents from total_cost_usd, covered by membership).
    `complete()`'s `apiKey` is now **optional**; only keyed providers require it. Print mode has no temperature/maxTokens.
  • **Everything defaults to the CLI:** new shared `apps/desktop/.../secrets/reasoning-config.ts`
    (`resolveReasoningConfig()`, `DEFAULT_REASONING_PROVIDER` = **claude-cli**, `VALID_PROVIDERS` now includes it).
    `reporting.ts` + `eval.ts` routes use it and gate the 422 "key not configured" behind `providerNeedsKey()`.
    `global-settings.ts` reasoning-defaults falls back to the shared claude-cli defaults. New helpers in ai-sdk:
    `providerNeedsKey()` / `llmAvailable(provider, apiKey)`. `getDashboard` gates classification on `llmAvailable`,
    not key truthiness. Keyed providers (anthropic/openai/gemini) remain selectable **overrides**, not removed.
  • **Renderer** `ConnectionsPage.tsx`: reasoning-model picker now offers claude-cli "(membership)" models (always
    selectable, no key); API-key cards reworded as optional; `isProviderConnected('claude-cli')` always true.
  • **Startup health-check** `checkClaudeCli()` (ai-sdk) — FREE, no token spend: `claude --version` + reads the
    credential store. Cross-platform: file `~/.claude/.credentials.json` (Linux/Win), **macOS Keychain**
    (`security find-generic-password -s "Claude Code-credentials"`), **Windows Cred Manager** (PS Win32 CredRead).
    3-state `authenticated: yes|no|unknown`. Surfaced at startup (terminal `[creare] reasoning (claude-cli): …`),
    via `GET /settings/claude-cli-health`, and a `MembershipStatusCard` banner in the UI. Verified on Kali: signed in, **max**.
  • **Dev script** `pnpm check:auth` (`scripts/check-claude-cli-auth.mjs`) — read-only; dumps store + entry name per OS
    to confirm/fix the `CREDENTIAL_SERVICE` constant. **TODO on Mac/Windows:** run it to verify the real entry name
    (the 'Claude Code-credentials' name is a best-effort guess).
  • **cwd isolation DONE** (commit `5620586`): print mode auto-discovers CLAUDE.md from cwd+parents, so reasoning
    calls from the repo leaked Creare's project context. Now spawns `claude` in an empty temp dir
    (`tmpdir/creare-ai-sdk-claude-cli`). Proven: provider answers "NONE" from repo root (was "Creare — an agentic
    DevOps platform…"). Spawn-mocked unit test added (tests **74/74**). (Can't use CLI "simple" mode — it forces
    API-key auth, breaking membership.)
- **Backlog wave (2026-06-10, Fable 5): DONE.** typecheck 23/23 · unit tests **73/73** · build clean · **E2E green**.
  • **Test coverage +28** (45→73): classifier rules + classification cache, correlator, sync-engine empty-fetch/txn
    guards, pm-command-center dashboard assembly + agent-activity (complete() mocked), observability edge cases.
  • **Eval + Memory exposed:** new `evalRoutes` (GET/POST `/projects/:id/eval-runs`) + `memoryRoutes`
    (GET/POST `/projects/:id/learnings`); new sidebar **Intelligence** page (Eval history + Memory recall/record).
  • **Playwright E2E now runs + passes on Kali** (display :0): the smoke spec was stale (asserted the removed
    login screen) — updated to assert auto-login → app shell. Full Electron stack verified end-to-end.
- **Multi-LLM + Confluence fix + macOS launcher (2026-06-10, Fable 5): DONE.** typecheck 21/21 · tests 45/45 · build clean.
  • **Model-agnostic LLM:** `ai-sdk` now implements OpenAI (`openai`) + Gemini (`@google/generative-ai`) providers
    alongside Anthropic; `complete()` dispatches all three; anthropic provider suppresses `temperature` for models
    that reject sampling params (opus-4-7/4-8, fable-5). Classifier/digest/NL-queries no longer hardcode Claude —
    provider+model are resolved from global settings `DEFAULT_REASONING_PROVIDER`/`DEFAULT_REASONING_MODEL` +
    `<PROVIDER>_API_KEY` (fallback anthropic/claude-haiku-4-5). Connections page: per-provider key cards + a
    default-reasoning-model picker (gated on the key being set); `GET /settings/reasoning-defaults` exposes the choice.
    Agent workspaces already supported per-workspace model. **No schema change** (global_settings is generic KV).
  • **Confluence scope** = Space **ID** (metadata key `spaceKey`→`spaceId` end-to-end; UI labeled + clarified).
  • **macOS launcher:** `install-desktop-entry.mjs` darwin branch builds `~/Applications/Creare.app` (Info.plist +
    launcher stub + icns via sips/iconutil when present); runs via `predev` on the Mac. **UNTESTED on real macOS.**
  • Approx OpenAI/Gemini pricing constants are placeholders (commented "verify").
- **Deepreview fixes (2026-06-10, Fable 5, 3 batches): DONE, uncommitted.** typecheck 21/21 · tests **45/45** · build clean.
  Grounded UI+perf deepreview → all findings fixed:
  • **Backend/perf:** classification now CACHED on `external_event_cache` (cols `classification`/`classified_at`,
    migration `0006`, SCHEMA_VERSION → **1.7.0**) — dashboard no longer re-runs Claude per item per load;
    `getActiveEvents` newest-first (`desc`) not oldest; sync purge+insert now transactional + skips on empty
    fetch (a GitHub 403 no longer blanks the cache); base connector throws on 401/403/429/5xx; cache index
    `(credential_id,purged_at)` + 7-day retention delete; `agent-activity` dropped-WHERE fixed (was scanning all
    projects); `getReadyTasks` N+1 → 3 queries + `task_edges_to_idx`; ai-sdk pricing corrected (Opus 500/2500,
    Haiku 100/500 cents/MTok). +1 regression test (newest-first).
  • **Frontend perf:** Gantt date inputs use local draft + optimistic cache update (no per-keystroke refetch storm
    + snap-back bug); Gantt memoized (scale/maps); dashboard no longer blanks to a spinner on every nav;
    **route-level code-splitting** (9 lazy chunks, main bundle 599 KB → 366 KB); `refetchOnWindowFocus:false`;
    timeline cache invalidation on task mutations.
  • **UI/a11y:** app now actually renders **dark** (the `.dark` class was never applied); shared `Badge`/`QueryError`/`Field`
    components; consistent readable badges (fixed illegible Connections/Settings chips); query errors show an error+retry
    card instead of a fake empty state; `onError` on all mutations; aria-labels on icon buttons; DelegateConfigDrawer is a
    real dialog (role/aria-modal/Escape/focus); real form labels; focus-visible rings; "Handle it"→"Dismiss"; post-connect
    CTA to Settings→Sources. Session log: `docs/sessions/session-2026-06-10-ui-a11y-pass.md`.
- **Global Connections refactor (2026-06-10, Fable 5): DONE, uncommitted.** Build + 44/44 tests green.
  Connections are now GLOBAL (workspace-level), not per-project — fixes the "select a project to view
  connections" gate. Two-layer model that prevents cross-project data mixing:
  • **`connections`** (new global table, migration `0004`) — one row per connected account: source +
    encrypted token + account metadata (Atlassian baseUrl/email). Plus **`global_settings`** for the
    workspace-level **Claude key** (`ANTHROPIC_API_KEY` moved here; reporting reads it globally).
  • **Per-project sources** = `integration_credentials` rows, now with a nullable **`connection_id`**
    (migration `0005`) pointing at a global connection; they hold the **resource scope** (github owner/repo,
    jira projectKey, confluence spaceKey=Space *ID*, notion databaseId) and a COPY of the connection's
    ciphertext token (re-propagated on rotation; detached on connection delete). SCHEMA_VERSION → **1.6.0**.
  • **Sync** merges connection account-meta + per-project scope (app layer; sync-engine untouched, still
    purges/keys cache by credentialId+projectId) → each project fetches only its slice → Claude only ever
    classifies one project's cache. No mixing by construction.
  • **UI**: Connections page (sidebar) is now global (no project needed) — manages the Claude key + tool
    accounts. New **Settings → Sources** tab binds a global connection to the current project + its scope.
  • Migrations `0004`+`0005` are additive (CREATE TABLE + ADD COLUMN) → auto-apply safely at next launch.
- **Connectors-UX + Gantt (2026-06-10, built on Fable 5 via subagents): DONE, uncommitted.**
  Verified on Kali: production build compiles (1570 modules), `pnpm --filter @creare/desktop typecheck`
  clean, `pnpm test` 44/44.
  1. **No login gate** — `ProtectedRoute` auto signs-in a local user (dev-stub); `/auth` kept as fallback.
  2. **New "Connections" hub** (sidebar, Plug icon → `/connections`, `pages/connections/ConnectionsPage.tsx`):
     one place for the Claude/Anthropic API key + every connector's credentials, with the CORRECT
     per-tool fields (Jira/Confluence: baseUrl+email+token → `metadata`; Notion: token+databaseId;
     GitHub: token+optional owner/repo; OneDrive: token). Settings trimmed to the Project tab;
     dashboard onboarding now links to /connections. (Named "Connections" because "Tools" nav = Tool Registry.)
  3. **Gantt/Timeline** — `tasks` gained `startDate`/`dueDate` (migration `0003_daily_impossible_man`,
     **SCHEMA_VERSION → 1.4.0**); `createTask`/`updateTask` + orchestration routes carry the dates;
     new `listEdges(projectId)` + aggregate `GET /projects/:id/timeline` ({tasks,edges,sprints,milestones}).
     UI: `pages/boards/TimelineTab.tsx` (new **Timeline** tab in Boards) — custom SVG/CSS Gantt: task bars,
     sprint bands, milestone diamonds, dependency arrows, a today line, inline date editing, and a
     per-task **focus mode** (BFS dependency chain). Create-task form (AgentsPage) gained start/due inputs.
  - NOTE: agent EXECUTION still intentionally not built — "Delegate" still just creates a `[Agent]`-labelled
    task (per decision 2026-06-10). Claude is used for planning/classification only.
- **Phase 3 (Domains 1–6 + Settings + wiring): COMPLETE, verified green on Kali, committed.**
  Domain 2 tool-registry, the Phase 3 review-fix set, Task 6 Real OAuth (GitHub + Entra),
  Task 7 background sync scheduler — all in.
- **Phase 4 (Eval & Intelligence): verified green on Kali, committed.**
  Test foundation (`vitest.config.ts`, `@creare/database/testing`), new
  `packages/eval` + `packages/memory`, schema additions (`eval_runs`,
  `learnings`, SCHEMA_VERSION 1.3.0, migration `0002` + snapshot), 11 test suites.
- **Verified 2026-06-09 ON KALI:** `pnpm run typecheck` 21/21 · `pnpm test` 44/44.
  Plus a full deepreview + fixes (event-log completeness, scheduler race, OAuth PKCE).

## BLOCKERS / CONSTRAINTS
- **Kali CAN build/typecheck/test now** (old "Mac-only" rule obsolete): `~/projects/.stignore`
  shields `node_modules`/`dist` from syncing. Procedure: `corepack prepare pnpm@9.0.0 --activate`
  + `corepack enable --install-directory ~/.local/bin pnpm` (PATH); `pnpm install --ignore-scripts`;
  `pnpm run typecheck`.
- **better-sqlite3 ABI swap is now AUTOMATIC** (2026-06-10) — no more manual rebuild before `pnpm test`.
  The single native `.node` can only hold one ABI: Node (vitest) or Electron (app/E2E). Whichever
  ran last used to win, so tests broke after launching the app (`NODE_MODULE_VERSION 123 vs 127`).
  Fix: `scripts/rebuild-better-sqlite3.mjs ensure <node|electron>` keeps a per-platform-arch cache
  in `.sqlite-abi/` + a `build/Release/.abi-target` marker, and swaps via instant file copy (~0.03s)
  instead of a ~15s recompile. Wired so it just works: vitest `globalSetup` → `ensure node` (covers
  test/test:watch/test:coverage); root `predev` + desktop `predev`/`pree2e` → `ensure electron`;
  desktop `pretest` → `ensure node`. First build of each ABI still compiles once, then it's cached.
  `rebuild:sqlite:node|electron` still force a fresh build. **`.sqlite-abi/` is gitignored.**
  ✅ VERIFIED on Kali 2026-06-10: `pnpm test` auto-swapped (`already built for node — nothing to do`)
  and ran **44/44 green**.
- `migration 0002` snapshot — ✅ DONE (regenerated; `meta/0002_snapshot.json` present).
- The Linux-compiled `better-sqlite3` `.node` lives under stignored `node_modules` (no Mac clobber);
  the Mac builds + caches its own ABIs on first `ensure` (cache files are platform-arch-tagged, so a
  synced Kali cache is ignored on the Mac rather than loaded).

- **Desktop app now LAUNCHES on Kali** (2026-06-10, `pnpm dev`). Two pre-existing blockers fixed
  (neither related to the better-sqlite3 ABI work — uncovered while verifying the launch):
  1. `turbo run dev` had 12 persistent tasks (11 package `tsc --watch` + the app) vs. default
     concurrency 10 → aborted before launch. Fixed: `"concurrency": "16"` in `turbo.json`.
  2. `apps/desktop/package.json` `"main"` was `dist/main/index.js`, but electron-vite outputs to
     `out/`. Fixed: `"main": "out/main/index.js"`.
  Verified: Electron window opens, Fastify API up on `127.0.0.1:4321`, renderer renders and drives
  the API (sign-in, /projects, /notifications, /events/stream SSE). The `atom_cache.cc` stderr line
  is a benign Electron-on-X11 warning.

## DESKTOP LAUNCHER (day-to-day, 2026-06-10) — Linux only, Mac-safe
- `pnpm dev` now self-installs an app-menu + Desktop icon on first run (`predev` →
  `scripts/install-desktop-entry.mjs`, idempotent, **Linux-only** — no-ops on macOS).
- The icon runs `scripts/launch-creare.sh` → `electron-vite preview` (production build, no
  dev server). It `ensure electron`'s the ABI first and builds `out/` if missing. Logs to
  `~/.cache/creare-launch.log`. Refresh after code changes: `pnpm --filter @creare/desktop build`.
- App icon lives in `apps/desktop/resources/` (NOT `build/` — `.stignore` ignores `build/`, so
  it would never sync to the Mac). `.sqlite-abi/` added to `.stignore` (per-platform binaries).
- Mac equivalent (Dock `.app`/`.dmg` via electron-builder) is NOT built yet — future option.

## RESUME HERE (next step, in order)
Phase 3 + Phase 4 are committed and verified green on Kali. This session's changes
(ABI auto-swap, app-launch fixes, desktop launcher) are **uncommitted**. Remaining:
1. On the **Mac**: pull/sync, `pnpm install`, re-run `pnpm run typecheck` + `pnpm test` for
   parity. The first `pnpm test`/`pnpm dev` auto-builds the Mac's own native `better-sqlite3`
   ABI (no manual `node-gyp` step). Approve per-project hooks on first open. Desktop-icon
   install no-ops on macOS — launch via `pnpm dev` there.
2. Then the FOLLOW-UPS below.

## FOLLOW-UPS
- ✅ DONE 2026-06-10 — Test suites for observability / integrations / reporting (now 73 unit tests).
- ✅ DONE 2026-06-10 — Playwright E2E runs + passes via `pnpm --filter @creare/desktop e2e` (needs a display;
  works on Kali :0 and on the Mac). `**/e2e/**` excluded from vitest so the two runners don't collide.
- ✅ DONE 2026-06-10 — Routes + UI for eval & memory (Intelligence page + /eval-runs + /learnings).
- OPEN (deferred by decision): agent EXECUTION (Delegate still just creates a `[Agent]` task — no runtime
  that runs the chosen LLM on a task); OAuth token *refresh*; cross-project 360 rollup. Verify OpenAI/Gemini
  pricing constants in `packages/ai-sdk/src/providers/*` (currently approximate placeholders).

---
*Conventions: synchronous `getDb()` domain APIs; append-only `events` log on every
mutation; UUIDs via `generateId()`; no `any`; `exactOptionalPropertyTypes`.*
*On "done for the day", update this file's STATUS NOW / RESUME HERE and the
auto-memory pointer ([[project-creare]]).*
