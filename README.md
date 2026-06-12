# Creare

**Local-first agentic DevOps platform** — a desktop app for managing software work, with **two-way board sync** to GitHub Projects, Jira, and Notion ("Azure DevOps, but better"). Import a remote board, then create / move / edit / close / comment on cards *from Creare* and have the changes push back to the source.

Electron + TypeScript monorepo (Turborepo + pnpm). Everything runs locally — no server, your data stays on your machine.

---

## What it does
- **Projects, Boards (Kanban), Sprints, Milestones, Timeline (Gantt).**
- **Connect a source** (Settings → Connections): GitHub, Jira, Confluence, Notion, OneDrive — owned **and** shared/invited resources.
- **Two-way mirror** (Boards → Import from GitHub, also Jira / Notion): pull a remote board in, drag/create/edit/close/comment → pushes back. Conflicts are surfaced and resolvable.
- **Import by URL** for GitHub Projects owned by another account you collaborate on.
- **PM dashboard** that triages your synced issues/PRs into Do-Now / Delegate / Risk.

---

## Prerequisites
- **Node.js 18–22** and **pnpm 9** (via corepack):
  ```bash
  corepack enable && corepack prepare pnpm@9.0.0 --activate
  ```
- **macOS build only:** Xcode Command Line Tools — `xcode-select --install` (needed to compile the native SQLite module).
- Reasoning/AI features (dashboard auto-triage, digests) use the **Claude Code CLI** logged into a Claude membership. **Optional** — board sync works fully without it.

---

## Run in development
```bash
git clone https://github.com/bubabb/creare.git
cd creare
pnpm install
pnpm dev          # launches the Electron app (Fastify API on 127.0.0.1:4321)
```
First run auto-signs-in a local user. Add a token on the **Connections** page to start syncing.

---

## Build a desktop installer

> Built with [electron-builder](https://www.electron.build/). Each installer is produced **on the matching OS** (a Mac `.dmg` must be built on a Mac, a Windows installer on Windows). Installers are **unsigned** (no developer certificate) — fine for internal testing; see the Gatekeeper/SmartScreen notes below.

### macOS (`.dmg`) — universal (Apple Silicon **and** Intel)
```bash
cd creare
pnpm install
pnpm --filter @creare/desktop package
```
- Output: **`apps/desktop/release/Creare-0.1.0-universal.dmg`**
- The Mac build is **universal by default** — the one `.dmg` runs on any Mac, so it doesn't need to match the tester's chip.
- **Installing it (unsigned):** open the `.dmg`, drag **Creare** to Applications. On first launch macOS will block it → **right-click Creare.app → Open → Open** (once). If it's stubborn: `xattr -cr /Applications/Creare.app`.

### Linux (`.AppImage` + `.deb`)
```bash
pnpm --filter @creare/desktop package
# → apps/desktop/release/Creare-0.1.0.AppImage  (chmod +x, then run)
```

### Windows (`.exe` installer) — run on Windows
```bash
pnpm --filter @creare/desktop package
# → apps/desktop/release/Creare Setup 0.1.0.exe
```
First launch shows SmartScreen → **More info → Run anyway** (once).

> Faster smoke test (unpacked app dir, no installer): `pnpm --filter @creare/desktop package:dir`

---

## Repo layout
```
apps/desktop/          Electron app (main = Fastify API + SQLite; renderer = React UI)
packages/
  agent-orchestration/ DAG task engine, agent workspaces
  tool-registry/       versioned AI tool artifacts
  observability/       traces, audit log
  boards/              Kanban / sprints / Gantt + remote-board mirror apply
  reporting/           PM dashboard, NL summaries
  integrations/        connectors (GitHub/Jira/Confluence/Notion/OneDrive), sync engine, mirror
  database/            SQLite + Drizzle ORM, migrations, append-only event log
  ai-sdk/              model-agnostic AI wrapper (defaults to Claude membership)
  shared/              types, ids, utils
docs/                  architecture, ADRs, glossary, session logs
```

## Useful scripts (repo root)
```bash
pnpm dev          # run the app
pnpm test         # unit tests (vitest)
pnpm run typecheck
pnpm run lint
pnpm --filter @creare/desktop e2e   # Playwright E2E (needs a display)
```

---

## Notes for testers
- Connect **your own** accounts/tokens on the Connections page — nothing from anyone else ships in the app. Your local data lives in `~/.creare/` (outside the repo).
- For GitHub Projects two-way sync, use a **classic PAT with `repo` + `project` scopes**.
- Known limits today: the **agent execution runtime** is not built yet (agent tasks are tracked, not auto-run); connector write/mirror flows are well-tested but the GitHub path is the one verified against live APIs.
