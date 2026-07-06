import { getDb, tasks } from '@pm-os/database'
import { and, eq } from 'drizzle-orm'
import { startTask, getReadyTasks, recoverStaleAgentTasks } from '@pm-os/agent-orchestration'
import { providerNeedsKey } from '@pm-os/ai-sdk'
import type { ModelProvider } from '@pm-os/ai-sdk'
import { getGlobalSetting } from '../secrets/global-settings-service'

// Background agent-task worker — runs in the headless server process (never the
// renderer). On a fixed interval (plus a debounced kick after a task is delegated) it
// finds READY pending agent tasks (DAG deps satisfied) and executes them via the
// agent-orchestration runtime (@pm-os/agent-orchestration startTask), which claims each
// task atomically, drives the model, records a trace, and updates status. Single-flight:
// whole drain passes never overlap (LLM calls are slow); a kick during a drain queues one
// follow-up. Tasks run sequentially within a pass (bounded concurrency is a follow-up).
//
// Tuning: PMOS_AGENT_INTERVAL_MS (default 10s). 0 disables the periodic scan (kicks still work).

const DEFAULT_INTERVAL_MS = 10_000
const KICK_DEBOUNCE_MS = 250

let started = false
let timer: ReturnType<typeof setInterval> | null = null
let kickTimer: ReturnType<typeof setTimeout> | null = null
let draining = false
let drainQueued = false

function defaultIntervalMs(): number {
  const raw = process.env['PMOS_AGENT_INTERVAL_MS']
  if (raw === undefined) return DEFAULT_INTERVAL_MS
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS
}

// Resolve an API key for a keyed provider from global settings. claude-cli (the default)
// needs none. The runtime only calls this for providers where providerNeedsKey is true.
export async function resolveApiKey(provider: ModelProvider): Promise<string> {
  if (!providerNeedsKey(provider)) return ''
  return (await getGlobalSetting(`${provider.toUpperCase()}_API_KEY`)) ?? ''
}

// One drain pass: run every ready agent task. Single-flight + never throws.
async function drainOnce(): Promise<void> {
  if (draining) {
    drainQueued = true
    return
  }
  draining = true
  try {
    const db = getDb()
    const pending = db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(and(eq(tasks.type, 'agent'), eq(tasks.status, 'pending')))
      .all()
    const projectIds = [...new Set(pending.map((t) => t.projectId))]
    for (const projectId of projectIds) {
      if (!started) break
      // getReadyTasks respects DAG dependencies (deps must be completed).
      const ready = getReadyTasks(projectId).filter((t) => t.type === 'agent')
      for (const task of ready) {
        if (!started) break
        try {
          await startTask(task.id, { resolveApiKey })
        } catch (err) {
          // startTask records its own failures on the task/trace; this is a last resort.
          console.error(`[pm-os] Agent task ${task.id} run error:`, err instanceof Error ? err.message : err)
        }
      }
    }
  } catch (err) {
    console.error('[pm-os] Agent task drain failed:', err instanceof Error ? err.message : err)
  } finally {
    draining = false
    if (drainQueued) {
      drainQueued = false
      void drainOnce()
    }
  }
}

/** Start the periodic ready-task scan (default ~10s). Idempotent. */
export function startTaskWorker(intervalMs?: number): void {
  if (started) return
  started = true
  const ms = intervalMs ?? defaultIntervalMs()
  void (async () => {
    // Crash recovery FIRST: agent tasks a prior session left 'in_progress' go back to
    // 'pending' (and their open traces are failed) so they re-run this session.
    try {
      const recovered = recoverStaleAgentTasks()
      if (recovered > 0) console.log(`[pm-os] Agent worker: recovered ${recovered} stale in-progress task(s) → pending`)
    } catch (err) {
      console.error('[pm-os] Agent worker: stale task recovery failed:', err instanceof Error ? err.message : err)
    }
    if (!started) return
    if (ms <= 0) {
      console.log('[pm-os] Agent worker periodic scan disabled (PMOS_AGENT_INTERVAL_MS=0)')
      return
    }
    timer = setInterval(() => {
      void drainOnce()
    }, ms)
    console.log(`[pm-os] Agent task worker started (scan every ${ms}ms)`)
    // Run one pass immediately so already-pending tasks don't wait a full interval.
    void drainOnce()
  })()
}

/** Debounced immediate scan — call after delegating/creating an agent task. Never throws. */
export function kickTaskWorker(): void {
  if (kickTimer) return
  kickTimer = setTimeout(() => {
    kickTimer = null
    void drainOnce()
  }, KICK_DEBOUNCE_MS)
}

/** Stop timers (teardown symmetry with the other workers). */
export function stopTaskWorker(): void {
  started = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (kickTimer) {
    clearTimeout(kickTimer)
    kickTimer = null
  }
}
