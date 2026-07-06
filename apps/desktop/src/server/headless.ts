/**
 * Headless server entrypoint — runs the full Creare backend (Fastify API +
 * sync scheduler + push worker) as a plain Node process, with NO Electron.
 *
 * This is the "Creare Server" runtime: the same backend the Electron app hosts
 * in its main process, minus the desktop window. The web UI is served as static
 * files from the Fastify server (see server.ts), so a browser pointed at the
 * printed URL is a full client. Nothing here imports `electron`, so it installs
 * and runs without the Electron binary or its native-module ABI.
 *
 * Run with:  tsx src/server/headless.ts   (see package.json "server" script)
 */
import { runMigrations } from '@creare/database'
import { startServer, stopServer, resolvePort } from '../main/server'
import { startSyncScheduler, stopSyncScheduler } from '../main/scheduler/sync-scheduler'
import { startPushWorker, stopPushWorker } from '../main/sync/push-worker'

// Validates CREARE_PORT (throws on a bad value) — shares server.ts's parser so the
// printed URL always matches the port the server actually binds.
const PORT = resolvePort()

// Tear backend services down exactly once, regardless of which signal fires.
let servicesStopped = false
async function stopServices(): Promise<void> {
  if (servicesStopped) return
  servicesStopped = true
  stopPushWorker()
  await stopSyncScheduler()
  await stopServer()
}

async function main(): Promise<void> {
  // Tell server.ts to serve the built web UI over HTTP (Electron never sets this).
  process.env['CREARE_SERVE_WEB'] = '1'
  runMigrations() // bring a fresh ~/.creare/creare.db up to date before serving
  await startServer()
  startSyncScheduler()
  startPushWorker()

  console.log('')
  console.log('  Creare is running (headless — no Electron).')
  console.log(`  Open the web UI:  http://127.0.0.1:${PORT}`)
  console.log(`  API + docs:       http://127.0.0.1:${PORT}/docs`)
  console.log('  Press Ctrl+C to stop.')
  console.log('')
}

// Graceful shutdown on Ctrl+C / kill. Each handler stops services, then exits.
// Use .finally so an early signal (before listen, or a rejected teardown) still
// exits the process instead of hanging on an unsettled promise.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stopServices().finally(() => process.exit(0))
  })
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[creare] failed to start: ${message}`)
  process.exit(1)
})
