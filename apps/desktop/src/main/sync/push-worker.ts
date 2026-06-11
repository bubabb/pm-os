import { getDb, integrationCredentials } from '@creare/database'
import { eq } from 'drizzle-orm'
import { drainMutationQueue } from '@creare/integrations'
import { getIntegrationToken, withMergedConnectionMetadata } from '../secrets'
import type { IntegrationCredential } from '@creare/database'

// Background push worker — runs in the Electron main process. Drains the
// durable mutation outbox (mutation_queue) to the remote on a fixed interval,
// plus a debounced immediate drain whenever a route enqueues a new op
// (kickPushWorker). drainMutationQueue itself is single-flight per credential;
// the guard here additionally keeps whole drain passes from overlapping in
// this process.
//
// Token handling mirrors the sync route: the credential row is loaded here and
// its plaintext token resolved via the secrets layer — @creare/integrations
// never touches ciphertext.
//
// Tuning: CREARE_PUSH_INTERVAL_MS (default 5s). Set to 0 to disable the
// periodic drain (kicks still work).

const DEFAULT_INTERVAL_MS = 5_000
const KICK_DEBOUNCE_MS = 250

let timer: ReturnType<typeof setInterval> | null = null
let kickTimer: ReturnType<typeof setTimeout> | null = null
let draining = false
let drainQueued = false

function defaultIntervalMs(): number {
  const raw = process.env['CREARE_PUSH_INTERVAL_MS']
  if (raw === undefined) return DEFAULT_INTERVAL_MS
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS
}

// Resolves a credential row + decrypted token for the drain loop — exactly the
// pair shape the sync route builds (withMergedConnectionMetadata merges the
// global connection's account metadata with the per-project scope).
async function getCredential(
  credentialId: string,
): Promise<{ credential: IntegrationCredential; token: string }> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId))
    .limit(1)
  if (row === undefined) {
    throw new Error(`push-worker: integration credential ${credentialId} not found`)
  }
  return {
    credential: await withMergedConnectionMetadata(row),
    token: await getIntegrationToken(row.id),
  }
}

// One drain pass. Single-flight: a call that arrives mid-drain queues exactly
// one follow-up pass (so an op enqueued during a drain is never stranded until
// the next interval tick). Never throws.
async function drainOnce(): Promise<void> {
  if (draining) {
    drainQueued = true
    return
  }
  draining = true
  try {
    const result = await drainMutationQueue(getCredential)
    if (result.applied + result.conflicts + result.failed > 0) {
      console.log(
        `[creare] Push drain: ${result.applied} applied, ${result.conflicts} conflicts, ${result.failed} failed`,
      )
    }
  } catch (err) {
    console.error('[creare] Push drain failed:', err instanceof Error ? err.message : err)
  } finally {
    draining = false
    if (drainQueued) {
      drainQueued = false
      void drainOnce()
    }
  }
}

/** Start the periodic outbox drain (default ~5s). Idempotent. */
export function startPushWorker(intervalMs?: number): void {
  if (timer) return
  const ms = intervalMs ?? defaultIntervalMs()
  if (ms <= 0) {
    console.log('[creare] Push worker periodic drain disabled (CREARE_PUSH_INTERVAL_MS=0)')
    return
  }
  timer = setInterval(() => {
    void drainOnce()
  }, ms)
  console.log(`[creare] Push worker started (drain every ${ms}ms)`)
}

/**
 * Debounced immediate drain — call after enqueueing a mutation so the push
 * goes out now instead of waiting for the next interval tick. Multiple kicks
 * inside the debounce window coalesce into one drain. Never throws.
 */
export function kickPushWorker(): void {
  if (kickTimer) return // a drain is already scheduled — coalesce
  kickTimer = setTimeout(() => {
    kickTimer = null
    void drainOnce()
  }, KICK_DEBOUNCE_MS)
}

/** Stop timers (teardown symmetry with stopSyncScheduler). */
export function stopPushWorker(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (kickTimer) {
    clearTimeout(kickTimer)
    kickTimer = null
  }
}
