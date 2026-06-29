# Creare

**Local-first agentic DevOps platform** — a desktop app for managing software work, with **two-way board sync** to GitHub Projects, Jira, and Notion ("Azure DevOps, but better"). Import a remote board, then create / move / edit / close / comment on cards *from Creare* and have the changes push back to the source.

TypeScript monorepo (Turborepo + pnpm). Everything runs locally — your data stays on your machine. Run it as an **Electron desktop app** or, on machines where Electron isn't allowed, as a **headless local web app + CLI** ([jump to setup](#run-without-electron-headless-web-app--cli)) — same backend either way.

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
  > The Electron desktop app compiles the same module against Electron's ABI, so this toolchain is needed for either runtime.
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

## Run without Electron (headless web app + CLI)

**Can't run an Electron app** (corporate policy, locked-down VM, or a proxy that blocks the Electron binary download / native-module compile)? Run the **exact same product** as a local web app — the backend is a plain localhost API and the UI is a normal browser SPA, so no Electron is involved.

```bash
git clone https://github.com/bubabb/creare.git
cd creare
pnpm install --ignore-scripts        # skips the Electron binary download
pnpm creare                          # builds packages + web UI, starts the server
```

Then open **http://127.0.0.1:4321** in any browser. That's the full app — same Boards, sync, dashboard, everything.

> **First run takes ~30–60s** while the native SQLite module compiles (needs a [C/C++ toolchain](#prerequisites)). You'll see build output, then `Creare is running` — wait for that line, then open the URL. Subsequent boots are instant.

- **Why `--ignore-scripts`:** it skips Electron's post-install binary download (the thing a corporate proxy usually kills). The headless runtime never needs the Electron binary, and the native SQLite module is built from source for the **Node** ABI — no Electron headers, nothing fetched from `electronjs.org`.
- **One runtime, one command.** `pnpm creare` = build the workspace packages → build the web UI (plain Vite) → start the Node server. Re-run it any time; rebuilds are cached.
- **Custom port:** `CREARE_PORT=5000 pnpm creare`. The UI is served same-origin, so it follows the port automatically.
- **Stop:** `Ctrl+C`. Your data lives in `~/.creare/` exactly as with the desktop app.

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

Point it at a non-default server with `CREARE_PORT=5000 pnpm cli …` or a full URL via `CREARE_API=http://host:port`.

> The Electron desktop app and this headless runtime are the **same backend** — pick whichever your environment allows. Running headless does not change or disable any feature.

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
pnpm dev          # run the Electron app
pnpm creare       # run headless (web UI at http://127.0.0.1:4321, no Electron)
pnpm cli <cmd>    # CLI client over the local API
pnpm web:build    # build just the web UI -> apps/desktop/out/web
pnpm test         # unit tests (vitest)
pnpm run typecheck
pnpm run lint
pnpm --filter @creare/desktop e2e   # Playwright E2E (needs a display)
```

---

## Notes for testers
- **Can't install Electron apps?** Use the [headless web app + CLI](#run-without-electron-headless-web-app--cli) — `pnpm install --ignore-scripts && pnpm creare`, then open http://127.0.0.1:4321. Same product, no Electron binary, nothing for a proxy to block.
- Connect **your own** accounts/tokens on the Connections page — nothing from anyone else ships in the app. Your local data lives in `~/.creare/` (outside the repo).
- For GitHub Projects two-way sync, use a **classic PAT with `repo` + `project` scopes**.
- Known limits today: the **agent execution runtime** is not built yet (agent tasks are tracked, not auto-run); connector write/mirror flows are well-tested but the GitHub path is the one verified against live APIs.
