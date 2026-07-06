import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'

// Resolve a workspace package to its TypeScript source, so the test run exercises
// source directly (via esbuild) instead of depending on built dist/ output. This
// keeps `pnpm test` fast and decoupled from the build, and lets tests import
// in-progress code on any machine.
const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    // Root package specifiers use anchored regexes so `@pm-os/database` does NOT
    // swallow the more specific `@pm-os/database/testing` subpath alias below.
    alias: [
      { find: '@pm-os/database/testing', replacement: fileURLToPath(new URL('./packages/database/src/testing.ts', import.meta.url)) },
      { find: /^@pm-os\/database$/, replacement: src('database') },
      { find: /^@pm-os\/shared$/, replacement: src('shared') },
      { find: /^@pm-os\/ai-sdk$/, replacement: src('ai-sdk') },
      { find: /^@pm-os\/agent-orchestration$/, replacement: src('agent-orchestration') },
      { find: /^@pm-os\/tool-registry$/, replacement: src('tool-registry') },
      { find: /^@pm-os\/observability$/, replacement: src('observability') },
      { find: /^@pm-os\/boards$/, replacement: src('boards') },
      { find: /^@pm-os\/reporting$/, replacement: src('reporting') },
      { find: /^@pm-os\/integrations$/, replacement: src('integrations') },
      { find: /^@pm-os\/eval$/, replacement: src('eval') },
      { find: /^@pm-os\/memory$/, replacement: src('memory') },
    ],
  },
  test: {
    // Swap the better-sqlite3 native addon to the Node ABI before any test loads
    // it (the desktop app leaves it on the Electron ABI). See the setup file.
    globalSetup: './vitest.globalsetup.ts',
    // better-sqlite3 is a native addon; the default 'threads' pool (worker_threads)
    // can segfault loading native modules. 'forks' runs each test file in a child process.
    pool: 'forks',
    globals: true,
    environment: 'node',
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts'],
    // e2e/** specs are Playwright-owned (run via `pnpm e2e`); vitest must not collect
    // them or it errors on Playwright's test.afterEach (different test runtime).
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    // Renderer (React) tests opt into jsdom per-file with: // @vitest-environment jsdom
    // (requires the `jsdom` dev dependency).
  },
})
