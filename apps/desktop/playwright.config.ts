import { defineConfig } from '@playwright/test'

// E2E drives the built Electron app (out/main/index.js). Run via `pnpm e2e`, which
// builds first. Needs better-sqlite3 compiled for the Electron ABI
// (`pnpm rebuild:sqlite:electron` from the repo root) and a display (or xvfb).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
})
