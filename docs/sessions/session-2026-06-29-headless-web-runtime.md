# Session Log — 2026-06-29 — Headless web runtime (Phase 1 + 2 + 3 + 4)

## Context / Why
Tester feedback (corporate machine): **cannot run an Electron app** (company policy);
a TUI or a local-server web app would be fine. They never reached the product — burned
hours on environment plumbing (corporate proxy killed the Electron binary download, then
better-sqlite3 wanted a fresh compile against Electron's ABI from a proxy-blocked host).
Their diagnosis: the Electron shell is premature scaffolding; the whole product is already
a headless localhost Fastify API + a pure HTTP-client React UI. Recommendation: run the
server headless + put a thin client (TUI/CLI/web) on the same API; keep Electron optional.

An Explore-agent coupling audit confirmed it: **only 5 files import `electron`**, the
renderer uses **zero** Electron features (plain `fetch` + `EventSource` to localhost:4321),
DB path uses `os.homedir()` not `app.getPath`, token encryption is `keys.json` + Node
WebCrypto (`safeStorage` only in a guarded legacy-migration branch). The one genuinely
coupled backend feature is OAuth (BrowserWindow redirect intercept) — deferrable, since
connectors use PATs and basic auth is a dev-user stub.

Decision (user picked): build a no-Electron **web app served from the headless server**
AND a thin CLI (CLI = next session). This session delivered Phase 1 + 2.

## What Was Done
- **Phase 1 — headless entrypoint:** `apps/desktop/src/server/headless.ts` — plain Node,
  zero Electron. Runs `runMigrations()` → `startServer()` → `startSyncScheduler()` →
  `startPushWorker()`, graceful SIGINT/SIGTERM shutdown, prints the web URL. Run via `tsx`.
- **Phase 2 — serve the existing React UI as a web app:**
  - `apps/desktop/vite.web.config.ts` — plain **Vite** (not electron-vite) build of the
    renderer → `out/web`. No electron dependency at build time. `base: './'` for relative
    asset URLs.
  - `server.ts` — added `registerWebUi()` (serves `out/web` via `@fastify/static` + SPA
    fallback to `index.html` for non-API GET requests). **Opt-in via `PMOS_SERVE_WEB=1`**
    (only `headless.ts` sets it) so the Electron path is byte-for-byte unchanged.
  - `renderer/lib/api.ts` + `sse.ts` — `API_BASE_URL` is now same-origin when served over
    http (`window.location.origin`), falling back to `http://localhost:4321` for Electron's
    `file://`. Also **fixes the deferred ':4321 hardcode' P2**.
- **Scripts / deps:** added `@fastify/static@^7` (fastify v4 line) + `tsx@^4` to
  `apps/desktop`; desktop scripts `web:build`, `server` (+ `preserver` ensures **node** ABI), `cli`;
  root scripts `build:packages` (turbo `--filter=./packages/*`, excludes the Electron build),
  `web:build`, `server`, `cli`, and `pm-os` (build packages → build web → start server).
- **Phase 3 — thin CLI:** `apps/desktop/src/server/cli.ts` (run via `tsx`; `pnpm cli <cmd>`).
  Dependency-free (global `fetch`). Auth via the `/auth/sign-in` dev-stub → JWT cached at
  `~/.pmos/cli-token.json` (mode 0600), with one automatic re-auth on 401. Commands: `health`
  (no auth), `projects [--all]`, `boards <p>`, `connections`, `sources <p>`, `status <p>`,
  `sync <p> [source]`, `open`, `help`. Global `--json` for raw output; a small table renderer
  otherwise. Friendly "server not running → pnpm pm-os" message on ECONNREFUSED. Does NOT touch
  the DB or better-sqlite3 (pure HTTP), so it needs no ABI step.
- **tsconfig fix:** `tsconfig.node.json` include now adds `src/server/**/*` — the new entry
  was initially *unchecked*; confirmed in the typecheck graph via `tsc -b --listFiles`.

## Verification (on Kali, this session)
- Booted `pnpm run server` (ports 4399–4402): API up, web UI served, scheduler + push worker
  started, claude-cli membership detected.
- HTTP exercised: `/health` 200 · `/` 200 `text/html` (real index.html w/ `#root` + bundled
  script) · `/assets/*.js` 200 · SPA fallback 200 · API 404 stays JSON (no HTML leak).
- Gate **GREEN**: desktop typecheck (`tsc -b`) ✓ · lint ✓ · **unit 293/293** ✓.
- Negative check: with `PMOS_SERVE_WEB` unset, `registerWebUi` returns early (no
  "serving web UI" log) → Electron path serves no web UI (unchanged).

## Decisions Made
- **Keep it inside `apps/desktop`** (already owns server.ts/routes/scheduler), not a new
  `apps/server` package — avoids cross-package boundary violation + turbo scaffolding.
- **`tsx` to run + `--ignore-scripts` install** rather than moving electron to optionalDeps.
  Lower risk, reversible, matches the existing Kali workflow; `--ignore-scripts` is exactly
  what dodges the tester's electron-binary-download blocker.
- **Web serving is opt-in** (`PMOS_SERVE_WEB=1`) so Electron behavior can't change.
- Web UI = the existing React SPA (HashRouter → no server rewrite needed), NOT a Next.js
  rewrite and NOT a TUI. Reuses 100% of the hardened/a11y'd renderer.

## CLI verification (this session)
- Against a live headless server (port 4410): `help`, `health` (status ok), `projects` (2 real
  seeded projects in a table), `connections` (1 github), `sources <p>` (github/idle), `boards <p>`
  ((none)), `projects --json` (raw), token cached 0600, and the ECONNREFUSED friendly error all
  worked. `sync <p> github` returned a 500 the CLI faithfully surfaced — the AES-GCM decrypt of an
  **orphaned token** (pre-existing; re-add the connection once per the known stable-key note), NOT
  a CLI/headless bug.

## Phase 4 — README (this session)
- Added a prominent **"Run without Electron (headless web app + CLI)"** section: one-command
  `pnpm install --ignore-scripts && pnpm pm-os` → http://127.0.0.1:4321, why `--ignore-scripts`
  dodges the Electron-binary/native-compile blockers, custom `PMOS_PORT`, and a full `pnpm cli`
  command reference (+ `PMOS_API`). Cross-linked from the intro, prerequisites (macOS CLT now
  noted as Electron-only), useful-scripts, and tester-notes. Phases 1–3 committed as `ff9eabb`.

## Fresh-clone verification — caught + fixed a real bug
Ran the tester's exact path: `git clone` from origin → `pnpm install --ignore-scripts`
→ `pnpm pm-os`. Install (7.8s, no Electron download), `build:packages` (11/11, 0 cached),
`web:build`, and the first-boot `better-sqlite3` Node-ABI compile all succeeded — **then the
server crashed**:
`Error: Electron failed to install correctly` at `auth/auth-service.ts:1`.

**Root cause:** `auth-service.ts`, `secrets/secrets-service.ts`, and `auth/oauth-service.ts`
each did a top-level `import { … } from 'electron'`. With `--ignore-scripts` there's no Electron
binary, so `require('electron')` throws at module load — and the headless server imports all
three transitively (auth + secrets routes). The dev machine had Electron installed, which masked
it entirely. This is exactly why a fresh clone matters.

**Fix:** new `apps/desktop/src/main/electron-optional.ts` exposing `getSafeStorage()` and
`getBrowserWindowCtor()` — lazy `require('electron')` in a try/catch, returning null when absent
(`import type` only, so no eager load). `safeStorage` usage (one-time legacy key migration) now
no-ops headless; the OAuth flow throws a clear "use a PAT in headless" at call-time instead of
crashing on import. Only `main/index.ts` (the Electron-only entry, never in the headless chain)
still imports electron eagerly.

**Re-verified** under the real condition (fix copied into the `--ignore-scripts` clone, no Electron
binary): server boots, `/health` 200, web UI + assets served, CLI `health`/`projects` work. Gate
green: typecheck · lint · unit 293/293.

## Files Created or Modified
- NEW `apps/desktop/src/server/headless.ts`
- NEW `apps/desktop/src/server/cli.ts`
- NEW `apps/desktop/src/main/electron-optional.ts` (lazy/optional Electron for headless)
- NEW `apps/desktop/vite.web.config.ts`
- `apps/desktop/src/main/auth/auth-service.ts` · `secrets/secrets-service.ts` ·
  `auth/oauth-service.ts` (top-level electron import → lazy via electron-optional)
- `README.md` (Phase 4 — "Run without Electron" section + cross-links)
- NEW `docs/sessions/session-2026-06-29-headless-web-runtime.md` (this file)
- `apps/desktop/src/main/server.ts` (static serving, opt-in gate)
- `apps/desktop/src/renderer/lib/api.ts` (+`API_BASE_URL`)
- `apps/desktop/src/renderer/lib/sse.ts` (same-origin SSE)
- `apps/desktop/tsconfig.node.json` (include src/server)
- `apps/desktop/package.json` (deps + scripts)
- `package.json` (root scripts)
- `pnpm-lock.yaml`

## Open Questions
- OAuth headless (BrowserWindow → loopback Fastify route + system browser) — deferred;
  not needed for the PAT-based connectors + dev-user stub, but required for app-level
  GitHub/Entra sign-in headless.
- One-command install ergonomics: document `pnpm install --ignore-scripts && pnpm pm-os`.
  Consider a `bin`/installer later. Native better-sqlite3 for Node ABI on the tester's
  machine should use prebuilt binaries (no Electron headers) — verify on their box.

## Next Session Should Start With
- **Phase 4 — docs/one-command**: README "Run without Electron" section documenting
  `pnpm install --ignore-scripts && pnpm pm-os` (web UI) and `pnpm cli <cmd>` (CLI), plus
  `PMOS_PORT`/`PMOS_API`. Optionally a `bin`/installer.
- **Optional CLI unit test:** `cli.ts` currently runs `main()` on import; to unit-test the table
  renderer / arg parsing, guard `main()` behind a "run directly" check and export the pure helpers,
  then mock `fetch`. Low value (thoroughly e2e-verified), so deferred.
- **OAuth-headless** (BrowserWindow redirect-intercept → real loopback Fastify callback route +
  open system browser) — deferred; connectors use PATs and basic auth is the dev-stub.
- Changes are **uncommitted** on `main`; gate is green. Commit when the user asks.
