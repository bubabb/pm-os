# Pm.Os

**Local-first agentic DevOps platform** — a local app for managing software work, with **two-way board sync** to GitHub Projects, Jira, and Notion ("Azure DevOps, but better"). Import a remote board, then create / move / edit / close / comment on cards *from Pm.Os* and have the changes push back to the source.

TypeScript monorepo (Turborepo + pnpm). Everything runs locally — your data stays on your machine. Pm.Os runs **headless**: a Fastify localhost API serving a React SPA as a local web app, plus a CLI. No Electron, no desktop binary — just a browser tab.

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
- **A C/C++ build toolchain** — the native SQLite module (`better-sqlite3`) is compiled **once on first run** (the `pnpm install --ignore-scripts` step skips the usual prebuilt-binary download, so it's built from source instead). First boot therefore takes ~30–60s while it compiles; every boot after is instant.
  - **macOS:** Xcode Command Line Tools — `xcode-select --install`
  - **Debian/Ubuntu/Kali:** `sudo apt install build-essential python3`
  - **Windows:** the “Desktop development with C++” workload (Visual Studio Build Tools) + Python 3
- Reasoning/AI features (dashboard auto-triage, digests) use the **Claude Code CLI** logged into a Claude membership. **Optional** — board sync works fully without it.

---

## Run it locally
```bash
git clone https://github.com/bubabb/pm-os.git
cd pm-os
pnpm install
pnpm pm-os        # builds the packages + web UI, then starts the server
```

Then open **http://127.0.0.1:4321** in any browser — that's the full app (Boards, sync, dashboard, everything). First run auto-signs-in a local user; add a token on the **Connections** page to start syncing.

> **First run takes ~30–60s** while the native SQLite module compiles (needs a [C/C++ toolchain](#prerequisites)). You'll see build output, then `Pm.Os is running` — wait for that line, then open the URL. Subsequent boots are instant.

- **One command.** `pnpm pm-os` = build the workspace packages → build the web UI (Vite) → start the Node server. Re-run it any time; rebuilds are cached.
- **Behind a strict proxy?** `pnpm install --ignore-scripts` skips the native-module prebuilt download; the SQLite module then compiles from source on first `pnpm pm-os`.
- **Custom port:** `PMOS_PORT=5000 pnpm pm-os`. The UI is served same-origin, so it follows the port automatically.
- **Stop:** `Ctrl+C`. Your data lives in `~/.pmos/`.

### CLI

A thin, scriptable client over the same local API (no browser needed):

```bash
pnpm cli health                    # is the server up?
pnpm cli projects [--all]          # list projects (--all includes archived)
pnpm cli boards <projectId>        # boards in a project
pnpm cli connections               # connected accounts
pnpm cli sources <projectId>       # a project's sources + sync status
pnpm cli status <projectId>        # sync status
pnpm cli sync <projectId> [source] # trigger a sync (optionally one source, e.g. github)
pnpm cli open                      # print the web UI URL
pnpm cli <command> --json          # raw JSON instead of a table (for scripting)
```

Point it at a non-default server with `PMOS_PORT=5000 pnpm cli …` or a full URL via `PMOS_API=http://host:port`.

---

## Repo layout
```
apps/desktop/          Headless runtime (main = Fastify API + SQLite; server = headless entry + CLI; renderer = React SPA web UI)
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
pnpm pm-os        # run the app (web UI at http://127.0.0.1:4321)
pnpm cli <cmd>    # CLI client over the local API
pnpm web:build    # build just the web UI -> apps/desktop/out/web
pnpm test         # unit tests (vitest)
pnpm run typecheck
pnpm run lint
```

---

## Notes for testers
- **Setup is just** `pnpm install && pnpm pm-os`, then open http://127.0.0.1:4321 — no desktop install, no Electron binary, nothing for a corporate proxy to block (add `--ignore-scripts` to the install if the proxy blocks native-module prebuilts).
- Connect **your own** accounts/tokens on the Connections page — nothing from anyone else ships in the app. Your local data lives in `~/.pmos/` (outside the repo).
- For GitHub Projects two-way sync, use a **classic PAT with `repo` + `project` scopes**.
- Known limits today: the **agent execution runtime** is not built yet (agent tasks are tracked, not auto-run); connector write/mirror flows are well-tested but the GitHub path is the one verified against live APIs.
