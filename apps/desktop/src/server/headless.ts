/**
 * Server entrypoint — runs the full Pm.Os backend (Fastify API + sync scheduler +
 * push worker) as a plain Node process. This IS the runtime (Electron was removed
 * 2026-07-06). The web UI is served as static files from the Fastify server (see
 * server.ts), so a browser pointed at the printed URL is a full client.
 *
 * Run with:  tsx src/server/headless.ts   (see package.json "server" script)
 */
import { runMigrations } from '@pm-os/database'
import { startServer, stopServer, resolvePort } from '../main/server'
import { startSyncScheduler, stopSyncScheduler } from '../main/scheduler/sync-scheduler'
import { startPushWorker, stopPushWorker } from '../main/sync/push-worker'

// Validates PMOS_PORT (throws on a bad value) — shares server.ts's parser so the
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
  // Tell server.ts to serve the built web UI over HTTP.
  process.env['PMOS_SERVE_WEB'] = '1'
  runMigrations() // bring a fresh ~/.pmos/pmos.db up to date before serving
  await startServer()
  startSyncScheduler()
  startPushWorker()

  console.log('')
  console.log('  Pm.Os is running.')
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
  console.error(`[pm-os] failed to start: ${message}`)
  process.exit(1)
})
