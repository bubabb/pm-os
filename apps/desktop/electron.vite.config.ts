import { cpSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// @pm-os/* workspace packages are pnpm symlinks — they do not survive
// electron-builder packaging, so they must be BUNDLED into the main/preload
// output instead of externalized. Everything else in dependencies (including
// the native better-sqlite3) stays external. The list is derived from
// package.json so new workspace deps are picked up automatically.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>
}
const workspacePackages = Object.keys(pkg.dependencies ?? {}).filter((dep) =>
  dep.startsWith('@pm-os/'),
)

// Bundle the workspace packages from their TypeScript SOURCE, not the built
// dist: the tsc-emitted CJS uses dynamic `__exportStar` re-exports that
// Rollup cannot statically enumerate ("getDb is not exported by ..."), and
// source resolution also removes the stale-dist failure mode. Exact-name
// match only — subpath imports (none today) would fall through to dist.
const workspaceSourceAlias = {
  find: /^@pm-os\/([a-z0-9-]+)$/,
  replacement: resolve(__dirname, '../../packages') + '/$1/src/index.ts',
}

// @pm-os/database's runMigrations() probes `join(__dirname, 'migrations')`.
// When the package was externalized, __dirname was packages/database/dist
// (which ships migrations); now that it is bundled, __dirname is out/main —
// so copy the SQL migrations next to the bundle. Keeps `pnpm dev` and E2E
// working, and doubles as an in-asar fallback for the packaged app (the
// canonical packaged path is process.resourcesPath/migrations, shipped via
// extraResources in electron-builder.yml).
const copyMigrationsPlugin: Plugin = {
  name: 'pm-os:copy-database-migrations',
  writeBundle() {
    cpSync(
      resolve(__dirname, '../../packages/database/src/migrations'),
      resolve(__dirname, 'out/main/migrations'),
      { recursive: true },
    )
  },
}

export default defineConfig({
  main: {
    // `jose` (JWT) is ESM-only — externalizing it makes the CJS main bundle do a
    // require() that throws ERR_REQUIRE_ESM. Exclude it so it gets bundled instead.
    plugins: [
      externalizeDepsPlugin({ exclude: ['jose', ...workspacePackages] }),
      copyMigrationsPlugin,
    ],
    resolve: {
      alias: [workspaceSourceAlias],
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // better-sqlite3 is a NATIVE module pulled in by the (now bundled)
        // @pm-os/database — it must never be bundled. It is also a direct
        // dependency (so externalizeDepsPlugin externalizes it), but keep the
        // explicit external as a guard.
        external: ['better-sqlite3'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    resolve: {
      alias: [workspaceSourceAlias],
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src/renderer') },
    },
  },
})
