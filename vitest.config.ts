import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'

// Resolve a workspace package to its TypeScript source, so the test run exercises
// source directly (via esbuild) instead of depending on built dist/ output. This
// keeps `pnpm test` fast and decoupled from the build, and lets tests import
// in-progress code on any machine.
const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    // Root package specifiers use anchored regexes so `@creare/database` does NOT
    // swallow the more specific `@creare/database/testing` subpath alias below.
    alias: [
      { find: '@creare/database/testing', replacement: fileURLToPath(new URL('./packages/database/src/testing.ts', import.meta.url)) },
      { find: /^@creare\/database$/, replacement: src('database') },
      { find: /^@creare\/shared$/, replacement: src('shared') },
      { find: /^@creare\/ai-sdk$/, replacement: src('ai-sdk') },
      { find: /^@creare\/agent-orchestration$/, replacement: src('agent-orchestration') },
      { find: /^@creare\/tool-registry$/, replacement: src('tool-registry') },
      { find: /^@creare\/observability$/, replacement: src('observability') },
      { find: /^@creare\/boards$/, replacement: src('boards') },
      { find: /^@creare\/reporting$/, replacement: src('reporting') },
      { find: /^@creare\/integrations$/, replacement: src('integrations') },
      { find: /^@creare\/eval$/, replacement: src('eval') },
      { find: /^@creare\/memory$/, replacement: src('memory') },
    ],
  },
  test: {
    // better-sqlite3 is a native addon; the default 'threads' pool (worker_threads)
    // can segfault loading native modules. 'forks' runs each test file in a child process.
    pool: 'forks',
    globals: true,
    environment: 'node',
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Renderer (React) tests opt into jsdom per-file with: // @vitest-environment jsdom
    // (requires the `jsdom` dev dependency).
  },
})
