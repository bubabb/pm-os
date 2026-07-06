import { getDb, projects, integrationCredentials, events } from '@pm-os/database'
import type { IntegrationCredential } from '@pm-os/database'
import { eq, isNull } from 'drizzle-orm'
import { generateId } from '@pm-os/shared'
import { triggerSync } from '@pm-os/integrations'
import { getIntegrationToken, isTokenExpired, withMergedConnectionMetadata } from '../secrets'
import { pruneOldRecords } from '../maintenance/prune'

// Background sync scheduler — runs in the Electron main process. On a fixed
// interval it triggers an integration sync for every non-archived project that
// has credentials. Per-credential started/completed/failed events are emitted by
// the sync engine itself; here we emit one system-level event per cycle.
//
// It also owns the daily retention prune (maintenance/prune.ts): once shortly
// after startup, then every 24 h — independent of the sync cycle, and it still
// runs when sync is disabled.
//
// Tuning: PMOS_SYNC_INTERVAL_MS (default 15 min). Set to 0 to disable sync.

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000
const PRUNE_STARTUP_DELAY_MS = 60 * 1000
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
let cycleRunning = false
// The promise of the cycle that is ACTUALLY running — assigned only when a cycle
// truly starts (not on the overlap-guard early return), so stopSyncScheduler
// awaits the real in-flight work instead of an immediately-resolved skip.
let activeCycle: Promise<void> | null = null
let pruneStartupTimer: ReturnType<typeof setTimeout> | null = null
let pruneTimer: ReturnType<typeof setInterval> | null = null

// Run the retention prune without ever letting an error escape into the
// scheduler's timer callbacks. pruneOldRecords logs the deleted counts itself.
function runPruneSafely(): void {
  try {
    pruneOldRecords()
  } catch (err) {
    console.error('[pm-os] Retention prune failed:', err instanceof Error ? err.message : err)
  }
}

function startPruneSchedule(): void {
  if (pruneStartupTimer || pruneTimer) return
  // First prune after a short delay so app boot isn't competing with deletes,
  // then daily thereafter.
  pruneStartupTimer = setTimeout(() => {
    pruneStartupTimer = null
    runPruneSafely()
    pruneTimer = setInterval(runPruneSafely, PRUNE_INTERVAL_MS)
  }, PRUNE_STARTUP_DELAY_MS)
}

function intervalMs(): number {
  const raw = process.env['PMOS_SYNC_INTERVAL_MS']
  if (raw === undefined) return DEFAULT_INTERVAL_MS
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS
}

// Syncs every active project once. Exported for testing and manual invocation.
// The overlap guard ensures a slow cycle never stacks on top of itself. When a
// cycle truly starts, its promise is published as activeCycle so teardown can
// await the real work; the overlap-skip returns without touching it.
export async function runSyncCycle(): Promise<void> {
  if (cycleRunning) {
    console.log('[pm-os] Sync cycle skipped — previous cycle still running')
    return
  }
  cycleRunning = true
  const cycle = runSyncCycleBody()
  activeCycle = cycle
  try {
    await cycle
  } finally {
    cycleRunning = false
    if (activeCycle === cycle) activeCycle = null
  }
}

// The actual sync work — one pass over every active project. Wrapped by
// runSyncCycle, which owns the overlap guard and activeCycle bookkeeping.
async function runSyncCycleBody(): Promise<void> {
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
          console.error(`[pm-os] Token decryption failed for credential ${usable[i]?.id}:`, r.reason)
        }
      })
      if (pairs.length === 0) continue

      await triggerSync(project.id, pairs)
      projectsSynced += 1
      credentialsSynced += pairs.length
    } catch (err) {
      // Isolate failures — one bad project must not abort the whole cycle.
      console.error(
        `[pm-os] Scheduled sync failed for project ${project.id}:`,
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
    }).catch((err) => console.error('[pm-os] Event log write failed:', err))
  }
}

export function startSyncScheduler(): void {
  if (timer) return
  // Retention prune runs regardless of whether the sync interval is disabled.
  startPruneSchedule()
  const ms = intervalMs()
  if (ms <= 0) {
    console.log('[pm-os] Background sync scheduler disabled (PMOS_SYNC_INTERVAL_MS=0)')
    return
  }
  // Don't run immediately on boot — let the app settle, then sync on the interval.
  // runSyncCycle publishes the real in-flight cycle as activeCycle itself, so the
  // timer callback only needs to swallow errors — it must NOT capture the promise
  // (an overlap-skip returns instantly and would hide a still-running cycle).
  timer = setInterval(() => {
    void runSyncCycle().catch((err) =>
      console.error('[pm-os] Sync cycle error:', err instanceof Error ? err.message : err),
    )
  }, ms)
  console.log(`[pm-os] Background sync scheduler started (every ${Math.round(ms / 1000)}s)`)
}

export async function stopSyncScheduler(): Promise<void> {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (pruneStartupTimer) {
    clearTimeout(pruneStartupTimer)
    pruneStartupTimer = null
  }
  if (pruneTimer) {
    clearInterval(pruneTimer)
    pruneTimer = null
  }
  // Wait for the ACTUALLY-running cycle to finish so teardown (e.g. stopServer)
  // doesn't race a sync mid-flight against the DB / network. activeCycle is the
  // real work promise (null when no cycle is running), so this can't return early
  // on a skipped-overlap promise the way awaiting the timer's return value would.
  if (activeCycle) {
    // A cycle that rejects at the setup path (e.g. DB error enumerating projects)
    // must not throw out of teardown — per-project errors are already isolated inside
    // the cycle; swallow here so stopServer() still runs.
    try {
      await activeCycle
    } catch {
      /* teardown proceeds regardless */
    }
    activeCycle = null
  }
  cycleRunning = false
}
