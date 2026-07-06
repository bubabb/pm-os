# Agent Task: Phase 1 — Base UI Shell (Task #6)
---
status: ready
phase: 1
task-id: 6
blocked-by: [1, 2, 3, 16, 19]
---

## Before You Start
Read in order:
1. `/project-scope.md` §3 (target users), §7 (design principles)
2. `/docs/GLOSSARY.md`
3. `/docs/agents/AGENT-PROTOCOL.md`
4. `/apps/desktop/CLAUDE.md`
5. `agent-state/handoffs/phase1-task5-output.md` — API base URL and auth token format

---

## Your Scope
You own: `apps/desktop/src/renderer/`

Do not touch:
- `apps/desktop/src/main/` (owned by Tasks #4 and #5)
- Any packages in `packages/`
- `apps/desktop/src/preload/index.ts` (only extend it if absolutely necessary)

---

## Context: What Exists
- React + Vite + Tailwind + shadcn/ui configured and building
- `src/renderer/index.css` — Tailwind directives + full shadcn/ui CSS variable theme
- `src/renderer/App.tsx` — placeholder only, replace it entirely
- Fastify API running at localhost:4321 (from Task #5)
- SSE stream at `/events/stream` for real-time updates (from Task #5)

---

## What You Must Produce

### 1. Initialize shadcn/ui components
Install the base components needed for the shell:
- Button, Input, Label (form primitives)
- Dialog, Sheet (overlays)
- DropdownMenu, NavigationMenu (navigation)
- Avatar, Badge (identity/status)
- Toaster (notifications)
- Separator, ScrollArea (layout)

### 2. API client (`src/renderer/lib/api.ts`)
- Typed fetch wrapper around `http://localhost:4321`
- Attaches JWT token from local storage to every request
- Handles 401 (redirect to sign-in) and 500 (toast error) globally
- `useApi()` hook wrapping TanStack Query

### 3. SSE client (`src/renderer/lib/sse.ts`)
- Connects to `/events/stream`
- Dispatches events to Zustand store
- Auto-reconnects on disconnect with exponential backoff

### 4. Auth flow (`src/renderer/pages/auth/`)
- Sign-in page with GitHub OAuth and Entra SSO buttons
- Auth state in Zustand: `{ user: User | null, isLoading: boolean }`
- `useAuth()` hook — redirects to sign-in if unauthenticated
- Protected route wrapper component

### 5. App shell (`src/renderer/App.tsx` + `src/renderer/layouts/`)
- Root layout: sidebar navigation + main content area + topbar
- Sidebar: project switcher, domain nav links (Boards, Agents, Tools, Observability, Reports)
- Topbar: current project name, notifications bell (unread count badge), user avatar + menu
- Responsive: sidebar collapses to icon-only below 1280px wide

### 6. Multi-project workspace management (`src/renderer/pages/projects/`)
- Project list page — all projects with last-active timestamp
- Create project dialog — name + optional description
- Project switcher in sidebar — persists last selected project in localStorage
- Archive project confirmation dialog

### 7. Project templates (`src/renderer/pages/projects/templates/`)
- "New AI Tool Project" template — pre-creates a board + agent workspace stub
- "New Agent Pipeline" template — pre-creates a DAG with 3 placeholder nodes
- "Blank Project" — empty project with no pre-created entities
- Template selection shown in create project dialog

### 8. Global notifications panel (`src/renderer/components/notifications/`)
- Slide-in Sheet from the topbar bell icon
- Lists unread notifications, grouped by type
- Mark as read individually or all-at-once
- Real-time updates via SSE client

---

## Done When
- [ ] App renders and routes work in Electron (`pnpm --filter @pm-os/desktop run dev`)
- [ ] Sign-in page shown when unauthenticated
- [ ] Project list loads from API after sign-in
- [ ] Project switcher correctly persists selection
- [ ] Sidebar navigation links render (placeholder pages for domains is fine)
- [ ] Notifications bell shows unread count
- [ ] All three project templates create correct entities via API
- [ ] TypeScript compiles with zero errors
- [ ] Handoff file written to `agent-state/handoffs/phase1-task6-output.md`
- [ ] `agent-state/agent-log.md` updated
- [ ] Session log written to `docs/sessions/`
