# Session Log — 2026-06-11 — Production packaging path (electron-builder)

## What Was Done
- Added the production packaging path (deepreview top blocker): new `apps/desktop/electron-builder.yml`, packaging scripts, and bundling of `@pm-os/*` workspace packages into the main/preload output.
- `electron.vite.config.ts`: `externalizeDepsPlugin({ exclude: ['jose', ...workspacePackages] })` (list derived from package.json automatically); same exclude for preload; explicit `external: ['better-sqlite3']` guard on main.
- Bundling resolves `@pm-os/*` to TypeScript **source** via a regex alias (`@pm-os/x` → `packages/x/src/index.ts`): tsc's CJS dist uses dynamic `__exportStar` re-exports Rollup can't enumerate ("getDb is not exported by dist/index.js"), and source resolution also kills the stale-dist failure mode.
- New `pm-os:copy-database-migrations` plugin copies `packages/database/src/migrations` → `out/main/migrations` on build, because bundling moves `__dirname` from `packages/database/dist` to `out/main` — keeps `runMigrations()`'s `join(__dirname,'migrations')` probe working in dev/E2E and as an in-asar fallback.
- `package.json`: added `package`/`package:dir` scripts, `description` + `author` (electron-builder requires them), `better-sqlite3` ^12.10.0 as a direct dep (it was only transitive via @pm-os/database; once that's bundled the native module must be a real dep so it stays external and gets collected/rebuilt by electron-builder), `electron-builder` ^24.13.0 devDep.
- `electron-builder.yml`: appId com.pmos.app, productName Pm.Os, output `release/`, files out/**+package.json, asarUnpack `**/*.node`, extraResources migrations → `process.resourcesPath/migrations`, npmRebuild true, linux AppImage+deb / mac dmg / win nsis.

## Verification
- `pnpm install --ignore-scripts` clean; `pnpm --filter @pm-os/desktop build` green.
- Bundle grep: `@pm-os` occurrences in out/main/index.js = **0** (bundled); `require("better-sqlite3")` = **1** (still external). Preload: 0.
- `tsc -b --noEmit` green; root unit suite **240/240**.
- Direct launch of built bundle (`electron out/main/index.js`): boots fully — Fastify on :4321, migrations run, claude-cli membership check OK.
- E2E (playwright) failed in `afterEach app.close()` teardown — **baseline with the ORIGINAL config fails identically** (verified via git stash), so it's environmental to this headless session, not the packaging change.
- electron-builder itself NOT run (needs network + per-OS signing); producing/launching a real installer still requires a real build machine per OS.

## Decisions Made
- Bundle workspace packages from src (alias), not dist — see __exportStar note above.
- better-sqlite3 promoted to a direct desktop dependency (same version spec as @pm-os/database, so pnpm links the identical store copy the ABI-swap script manages).
- Migrations ship two ways: extraResources (canonical packaged path) + copy into out/main (dev/E2E + asar fallback).

## Files Created or Modified
- apps/desktop/electron.vite.config.ts (modified)
- apps/desktop/package.json (modified)
- apps/desktop/electron-builder.yml (new)
- pnpm-lock.yaml (electron-builder + better-sqlite3 direct dep)

## Open Questions
- E2E teardown hang in this session (pre-existing, environmental) — re-run on a machine with a display to confirm gate.
- electron-builder collects node_modules for the `@pm-os/*` entries still listed in dependencies (pnpm symlinks); harmless bloat expected since runtime code is bundled, but verify on the first real package run; consider `files` excludes if size matters.
- mac (icns) and win (ico) icons not provided; linux uses resources/icon.png.

## Next Session Should Start With
- On a real build machine: `pnpm --filter @pm-os/desktop package:dir`, launch `release/linux-unpacked/pm-os`, confirm migrations load from resourcesPath and better-sqlite3 ABI is Electron's.
