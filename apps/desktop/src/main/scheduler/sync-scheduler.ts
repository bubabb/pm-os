import { getDb, projects, integrationCredentials, events } from '@creare/database'
import type { IntegrationCredential } from '@creare/database'
import { eq, isNull } from 'drizzle-orm'
import { generateId } from '@creare/shared'
import { triggerSync } from '@creare/integrations'
import { getIntegrationToken, isTokenExpired, withMergedConnectionMetadata } from '../secrets'

// Background sync scheduler — runs in the Electron main process. On a fixed
// interval it triggers an integration sync for every non-archived project that
// has credentials. Per-credential started/completed/failed events are emitted by
// the sync engine itself; here we emit one system-level event per cycle.
//
// Tuning: CREARE_SYNC_INTERVAL_MS (default 15 min). Set to 0 to disable.

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
let cycleRunning = false
let cyclePromise: Promise<void> | null = null

function intervalMs(): number {
  const raw = process.env['CREARE_SYNC_INTERVAL_MS']
  if (raw === undefined) return DEFAULT_INTERVAL_MS
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS
}

// Syncs every active project once. Exported for testing and manual invocation.
// The overlap guard ensures a slow cycle never stacks on top of itself.
export async function runSyncCycle(): Promise<void> {
  if (cycleRunning) {
    console.log('[creare] Sync cycle skipped — previous cycle still running')
    return
  }
  cycleRunning = true
  try {
    const db = getDb()
    const activeProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(isNull(projects.archivedAt))

    let projectsSynced = 0
    let credentialsSynced = 0

    for (const project of activeProjects) {
      try {
        const credentials = await db
          .select()
          .from(integrationCredentials)
          .where(eq(integrationCredentials.projectId, project.id))
        if (credentials.length === 0) continue

        // Skip expired OAuth tokens — they would only produce auth failures.
        const usable = credentials.filter((c) => !isTokenExpired(c))
        if (usable.length === 0) continue

        // allSettled (not all): one credential's decryption failure must not drop the
        // project's healthy credentials for this cycle.
        const settled = await Promise.allSettled(
          usable.map(async (credential) => ({
            // Merge the global connection's account metadata (baseUrl, email)
            // with this source's per-project scope — shallow clone, row untouched.
            credential: await withMergedConnectionMetadata(credential),
            token: await getIntegrationToken(credential.id),
          })),
        )
        const pairs = settled
          .filter(
            (r): r is PromiseFulfilledResult<{ credential: IntegrationCredential; token: string }> =>
              r.status === 'fulfilled',
          )
          .map((r) => r.value)
        settled.forEach((r, i) => {
          if (r.status === 'rejected') {
            console.error(`[creare] Token decryption failed for credential ${usable[i]?.id}:`, r.reason)
          }
        })
        if (pairs.length === 0) continue

        await triggerSync(project.id, pairs)
        projectsSynced += 1
        credentialsSynced += pairs.length
      } catch (err) {
        // Isolate failures — one bad project must not abort the whole cycle.
        console.error(
          `[creare] Scheduled sync failed for project ${project.id}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    if (credentialsSynced > 0) {
      db.insert(events).values({
        id: generateId(),
        type: 'integration.sync.scheduled',
        domain: 'integrations',
        projectId: null,
        actorType: 'system',
        actorId: 'sync-scheduler',
        resourceType: 'integration_sync',
        resourceId: null,
        payload: JSON.stringify({ projectsSynced, credentialsSynced }),
      }).catch((err) => console.error('[creare] Event log write failed:', err))
    }
  } finally {
    cycleRunning = false
  }
}

export function startSyncScheduler(): void {
  if (timer) return
  const ms = intervalMs()
  if (ms <= 0) {
    console.log('[creare] Background sync scheduler disabled (CREARE_SYNC_INTERVAL_MS=0)')
    return
  }
  // Don't run immediately on boot — let the app settle, then sync on the interval.
  timer = setInterval(() => {
    cyclePromise = runSyncCycle().catch((err) =>
      console.error('[creare] Sync cycle error:', err instanceof Error ? err.message : err),
    )
  }, ms)
  console.log(`[creare] Background sync scheduler started (every ${Math.round(ms / 1000)}s)`)
}

export async function stopSyncScheduler(): Promise<void> {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // Wait for an in-flight cycle to finish so teardown (e.g. stopServer) doesn't race
  // a sync that is mid-flight against the DB / network.
  if (cyclePromise) {
    await cyclePromise
    cyclePromise = null
  }
  cycleRunning = false
}
