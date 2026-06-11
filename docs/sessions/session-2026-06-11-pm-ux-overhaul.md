# Session Log — 2026-06-11 — PM UX overhaul (P0→P2) + connections resource picker

## What Was Done
Full-sweep UX overhaul toward top-1% PM-app quality, driven by **Fable 5** subagents
(orchestrated by Opus 4.8). Started from a grounded Fable 5 deepreview of the
project-management UX (Ground → Verify → Break-it), then executed all findings in two
waves of parallel agents editing disjoint files, then verified the full gate.

**Deepreview** surfaced 20 prioritized findings; the highest-leverage P0s were: the
project-create template picker was decorative, "archive" promised a restore that was
impossible, and there was no real in-place project switcher.

**Wave A — Foundations (4 parallel Fable 5 agents, disjoint files):**
- Backend project lifecycle (`routes/projects.ts`): `?archived=1` listing, `POST
  /projects/:id/restore` (unarchive), hardened PATCH (whitelist name/description + length
  validation, no more body spread), validated create, and **real template scaffolding**
  (`ai-tool` → board + workspace; `agent-pipeline` → workspace + 3-task DAG via addEdge;
  `blank` → nothing) using the boards / agent-orchestration public APIs. Scaffolding is
  best-effort (project still returns if it partially fails).
- Backend connector resources: new `ResourceOption` type + optional `listResources()` on
  `BaseConnector`, implemented for all 5 connectors (GitHub uses
  `affiliation=owner,collaborator,organization_member` → covers public/private/invited),
  a public `listConnectorResources(source, config)` helper, and a `GET
  /connections/:connectionId/resources` route (502 → UI falls back to manual entry).
- Shared renderer UI primitives: `Dialog` (accessible: role/aria-modal/Escape/focus
  trap/restore), `Spinner`, `Toast` (`toast.success/error/info` + `ToastViewport`),
  `EmptyState` + `NoProject`, `CommandPalette` (Cmd/Ctrl+K), `lib/format.ts`
  (formatDate/formatRelative). `<ToastViewport/>` mounted in `App.tsx`. No new deps.
- Project store (`store/projects.ts`): `error` state, template-aware `createProject`,
  `renameProject`, `unarchiveProject` + `archived`/`loadArchived`, recency sort, load
  error handling.

**Wave B — Pages (4 parallel Fable 5 agents, disjoint files):**
- `ProjectList.tsx` rebuilt: Dialog-based create (double-submit guard + catch + inline
  error + toast), colored/emoji avatars, favorites (localStorage), type-ahead filter,
  loading/error states, **Archived section with working Restore**, truthful archive copy.
- `AppShell.tsx`: **real in-place project switcher** popover (switch without navigating
  away), CommandPalette mounted + ⌘K chip, breadcrumb topbar, collapsed tooltips, Settings
  promoted into sidebar nav.
- `Settings.tsx`: editable Project tab (rename via renameProject + toast); **resource
  picker** in Sources (queries the new route, searchable list of repos/projects/spaces,
  manual-entry fallback on 502/empty).
- `BoardsPage.tsx`: **native HTML5 drag-and-drop** Kanban (optimistic move via the
  existing `moveItem` mutation; dropdown kept as the accessible fallback).

## Decisions Made
- **PAT over OAuth for GitHub connections** (and the picker generalizes to all connectors):
  Creare is local-first with no server to hold a client secret, so OAuth would *add*
  friction (each user registering their own app). Decision: keep paste-a-token, make it
  excellent via a live resource picker. (See conversation rationale.)
- **No new dependencies** — Dialog/Toast/CommandPalette/DnD all built in-house with the
  existing React/Tailwind/lucide stack to avoid dependency churn + native-ABI risk.
- **Project color/emoji/favorites are client-side** (deterministic from id + localStorage)
  to avoid a schema migration.
- Orchestrated as disjoint-file parallel waves so 8 Fable 5 agents never collided.

## Files Created or Modified
Created: `apps/desktop/src/renderer/components/ui/Dialog.tsx`, `Spinner.tsx`, `Toast.tsx`,
`EmptyState.tsx`, `CommandPalette.tsx`; `apps/desktop/src/renderer/lib/format.ts`.
Modified: `apps/desktop/src/main/routes/projects.ts`, `apps/desktop/src/main/routes/connections.ts`,
`apps/desktop/src/renderer/App.tsx`, `layouts/AppShell.tsx`,
`pages/projects/ProjectList.tsx`, `pages/settings/Settings.tsx`, `pages/boards/BoardsPage.tsx`,
`store/projects.ts`; `packages/integrations/src/types.ts`, `index.ts`,
`connectors/{base,github,jira,confluence,notion,onedrive}.ts`.
(16 files, +1507/−273.)

## Verification
Full gate GREEN on Kali: typecheck **23/23** · unit **81/81** · lint **12/12** · E2E **2/2**.
NOTE: the first E2E run failed with `EADDRINUSE :4321` — a **leftover Electron process**
(pid 28602) from an earlier manual preview was holding the Fastify port; killing it fixed
it. Not a code issue. (Reminder: kill stray `out/main/index.js`/preview procs before E2E.)

## Open Questions
- All changes are **uncommitted** on branch `feat/claude-cli-membership-provider`. Decide:
  commit here, or branch off `main` for the UX work, or merge the membership branch first.
- Backend create still defaults templateId to 'blank'; OpenAI/Gemini pricing constants
  remain placeholders (pre-existing).

## Next Session Should Start With
- Decide commit/branch strategy and commit the UX overhaul.
- Optional polish not yet done from the deepreview: cross-project overview dashboard,
  bulk actions, drag-reorder within a column (only cross-column move is wired).
