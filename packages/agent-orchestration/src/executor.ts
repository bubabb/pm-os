// Agent execution runtime — actually RUNS an agent task: binds/activates a workspace,
// opens an observability trace, drives a think→act→observe loop over the ai-sdk (with
// tools when the provider supports them, single-step otherwise), enforces per-workspace
// daily cost/token guardrails, stores the deliverable on the task + trace, and emits the
// execution events. Provider-agnostic: the model + provider come from the workspace; keyed
// providers get their key via an injected resolver.
import { getDb, agentWorkspaces, tasks, traces, events } from '@pm-os/database'
import { and, eq, inArray } from 'drizzle-orm'
import { generateId } from '@pm-os/shared'
import {
  complete,
  supportsTools,
  llmAvailable,
  providerNeedsKey,
  type ModelProvider,
  type Message,
  type ToolResult,
} from '@pm-os/ai-sdk'
import { createTrace, addTraceEvent, updateTrace } from '@pm-os/observability'
import { getTask, getWorkspace, createWorkspace, updateTask, updateWorkspaceStatus, listWorkspaces } from './index'
import { listAgentTools, executeAgentTool, type ToolContext } from './tools'
import type { AgentWorkspace, Task } from './index'

// Providers the AI SDK actually supports (the DB enum is a superset — it also has 'local').
const AISDK_PROVIDERS: readonly ModelProvider[] = ['anthropic', 'openai', 'gemini', 'claude-cli']
function isAisdkProvider(p: string): p is ModelProvider {
  return (AISDK_PROVIDERS as readonly string[]).includes(p)
}

// ── Config (env-tunable, validated, sane defaults) ────────────────────────────
const DEFAULT_PROVIDER: ModelProvider = ((): ModelProvider => {
  const raw = process.env['PMOS_AGENT_PROVIDER']
  return raw && isAisdkProvider(raw) ? raw : 'claude-cli'
})()
const DEFAULT_MODEL = process.env['PMOS_AGENT_MODEL'] || 'claude-haiku-4-5-20251001'
const MAX_ITERATIONS = Math.max(1, Number(process.env['PMOS_AGENT_MAX_ITERATIONS']) || 8)
const MAX_OUTPUT_TOKENS = Math.max(256, Number(process.env['PMOS_AGENT_MAX_TOKENS']) || 8192)
const COST_WARN_RATIO = 0.8 // soft-warn at 80% of a daily limit

const DEFAULT_WORKSPACE_NAME = 'Default Agent'

const AGENT_SYSTEM_PROMPT = [
  'You are an autonomous DevOps agent inside Pm.Os working a single delegated task.',
  'Use the available tools to inspect the project when it helps. When you have done the work,',
  'reply with a concise, concrete DELIVERABLE: what you found/did and any recommended follow-up.',
  'Do not ask the user questions — produce the best result you can from the task and tools.',
].join(' ')

class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError' }
}

// Tasks currently executing IN THIS PROCESS. Guards against a double-run when a task's
// status is externally reset to 'pending' mid-run (the atomic claim only guards the
// pending→in_progress edge; this guards the whole run).
const runningTasks = new Set<string>()
// Running tasks a caller asked to cancel; the loop checks this between steps. Only ever
// holds ids of tasks that are actually running (cleared in startTask's finally), so it
// cannot leak on a pending-cancel path.
const cancelledTasks = new Set<string>()

export interface ExecuteTaskOptions {
  // Resolve an API key for a keyed provider (anthropic/openai/gemini). claude-cli needs
  // none. Injected by the caller (apps/desktop owns secrets); defaults to no key.
  resolveApiKey?: (provider: ModelProvider) => Promise<string> | string
  maxIterations?: number
}

// ── Public API (fulfils CONTRACT.md: startTask / cancelTask) ──────────────────

// Run a single agent task. Safe to call from a worker loop or a route; claims the task
// atomically so it can't double-run. GUARDRAIL/PAUSE semantics: a task whose workspace is
// over its daily budget, or paused, is LEFT PENDING (it retries after the daily reset /
// unpause) rather than failed — so a spent budget never burns the queued backlog. Never throws.
export async function startTask(taskId: string, opts: ExecuteTaskOptions = {}): Promise<Task | null> {
  const task = getTask(taskId)
  if (!task) return null
  if (task.type !== 'agent') return task
  if (runningTasks.has(taskId)) return task // already executing here — don't double-run

  const workspace = resolveWorkspace(task)
  if (workspace.status === 'terminated') {
    // The assigned workspace is gone — a real terminal failure (no retry can fix it).
    if (claimTask(taskId, workspace.id)) failClaimed(taskId, workspace, 'Assigned agent workspace was terminated.')
    return getTask(taskId)
  }
  if (workspace.status === 'paused') return task // leave pending — runs when unpaused
  if (overHardCap(workspace.id)) return task     // over daily budget — pause (retries after reset)

  if (!claimTask(taskId, workspace.id)) return getTask(taskId) // lost the claim race / not pending
  runningTasks.add(taskId)
  cancelledTasks.delete(taskId)
  try {
    await runTask(taskId, workspace, opts)
  } catch (err) {
    console.error(`[agent] unhandled error running task ${taskId}:`, err)
  } finally {
    runningTasks.delete(taskId)
    cancelledTasks.delete(taskId)
  }
  return getTask(taskId)
}

// Request cancellation. A queued (pending) task is cancelled immediately; a running task
// stops at its next loop checkpoint and is marked cancelled by runTask.
export function cancelTask(taskId: string): Task | null {
  const task = getTask(taskId)
  if (!task) return null
  if (task.status === 'in_progress' || runningTasks.has(taskId)) {
    cancelledTasks.add(taskId) // signalled to the running loop; cleared in startTask's finally
    return task
  }
  if (task.status === 'pending') return updateTask(taskId, { status: 'cancelled' }, undefined, 'system') ?? null
  return task
}

// Reset agent tasks left 'in_progress' by a crash back to 'pending' (failing their open
// traces + idling any stuck-'running' workspace), so they re-run on the next worker tick.
// Emits a task.recovered event per task (append-only log). Call once at worker startup.
export function recoverStaleAgentTasks(): number {
  const db = getDb()
  const stale = db.select().from(tasks).where(and(eq(tasks.type, 'agent'), eq(tasks.status, 'in_progress'))).all()
  const now = new Date().toISOString()
  if (stale.length > 0) {
    const ids = stale.map((t) => t.id)
    db.update(tasks).set({ status: 'pending', startedAt: null, updatedAt: now }).where(inArray(tasks.id, ids)).run()
    db.update(traces).set({ status: 'failed', completedAt: now }).where(and(inArray(traces.taskId, ids), eq(traces.status, 'running'))).run()
    for (const t of stale) logEvent(t.projectId, 'task.recovered', 'system', null, 'task', t.id, { taskId: t.id })
  }
  // No agent task is running at startup, so any workspace left 'running' by a crash is stale.
  db.update(agentWorkspaces).set({ status: 'idle', updatedAt: now }).where(eq(agentWorkspaces.status, 'running')).run()
  return stale.length
}

// ── Internals ─────────────────────────────────────────────────────────────────

function resolveWorkspace(task: Task): AgentWorkspace {
  if (task.agentWorkspaceId) {
    const ws = getWorkspace(task.agentWorkspaceId)
    if (ws) return ws // may be terminated/paused — the caller checks status
  }
  return getOrCreateDefaultWorkspace(task.projectId)
}

// Atomic claim: pending → in_progress (binding the workspace) only if still pending.
function claimTask(taskId: string, workspaceId: string): boolean {
  const now = new Date().toISOString()
  const res = getDb()
    .update(tasks)
    .set({ status: 'in_progress', agentWorkspaceId: workspaceId, startedAt: now, updatedAt: now })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')))
    .run()
  if (res.changes === 1) {
    const t = getTask(taskId)
    if (t) logEvent(t.projectId, 'task.started', 'agent', workspaceId, 'task', taskId, { taskId, agentWorkspaceId: workspaceId })
  }
  return res.changes === 1
}

// Terminal failure for an already-claimed task whose workspace is unusable.
function failClaimed(taskId: string, workspace: AgentWorkspace, message: string): void {
  const t = getTask(taskId)
  if (t) {
    const trace = createTrace({ agentWorkspaceId: workspace.id, projectId: t.projectId, taskId })
    addTraceEvent(trace.id, { type: 'error', payload: { error: message } })
    updateTrace(trace.id, { status: 'failed', durationMs: 0, completedAt: new Date().toISOString() })
    logEvent(t.projectId, 'task.failed', 'agent', workspace.id, 'task', taskId, { taskId, error: message })
  }
  updateTask(taskId, { status: 'failed' }, workspace.id, 'agent')
}

function getOrCreateDefaultWorkspace(projectId: string): AgentWorkspace {
  const existing = listWorkspaces(projectId).find((w) => w.name === DEFAULT_WORKSPACE_NAME)
  if (existing) return existing
  return createWorkspace(projectId, {
    name: DEFAULT_WORKSPACE_NAME,
    modelProvider: DEFAULT_PROVIDER as AgentWorkspace['modelProvider'],
    modelId: DEFAULT_MODEL,
    // Default workspace may use every built-in tool (all are safe + read-mostly).
    permissionScope: { tools: '*' },
  })
}

function parseAllowedTools(permissionScope: string | null): string[] | '*' {
  try {
    const parsed = JSON.parse(permissionScope ?? '{}') as { tools?: string[] | '*' }
    if (parsed.tools === '*') return '*'
    return Array.isArray(parsed.tools) ? parsed.tools : []
  } catch {
    return []
  }
}

async function runTask(taskId: string, workspace: AgentWorkspace, opts: ExecuteTaskOptions): Promise<void> {
  const task = getTask(taskId)!
  updateWorkspaceStatus(workspace.id, 'running')
  logEvent(task.projectId, 'agent.workspace.activated', 'agent', workspace.id, 'agent_workspace', workspace.id, { taskId })

  const trace = createTrace({ agentWorkspaceId: workspace.id, projectId: task.projectId, taskId })
  const startedMs = Date.now()
  let totalIn = 0
  let totalOut = 0
  let totalCost = 0
  let finished = false

  // Single terminal transition for the whole run (finish-once): closes the trace, idles the
  // workspace, sets the task's terminal status + result, all attributed to the agent.
  const finish = (status: 'completed' | 'failed' | 'cancelled', result: string | null): void => {
    if (finished) return
    finished = true
    updateTrace(trace.id, {
      status: status === 'completed' ? 'completed' : 'failed',
      inputTokens: totalIn,
      outputTokens: totalOut,
      costCents: totalCost,
      durationMs: Date.now() - startedMs,
      completedAt: new Date().toISOString(),
    })
    updateWorkspaceStatus(workspace.id, 'idle')
    // updateTask emits the single, agent-attributed task.<status> event (no duplicate here).
    updateTask(taskId, { status, ...(result !== null ? { result } : {}) }, workspace.id, 'agent')
  }

  try {
    const provider = toModelProvider(workspace.modelProvider)
    if (!provider) throw new Error(`Workspace model provider '${workspace.modelProvider}' is not supported by the AI SDK.`)
    const apiKey = providerNeedsKey(provider) ? String((await opts.resolveApiKey?.(provider)) ?? '') : ''
    if (!llmAvailable(provider, apiKey)) {
      throw new Error(`No LLM available for provider '${provider}' (missing API key or the claude CLI is not logged in).`)
    }

    const ctx: ToolContext = { projectId: task.projectId, actorId: workspace.id, allowedTools: parseAllowedTools(workspace.permissionScope) }
    const tools = supportsTools(provider) ? listAgentTools(ctx) : []

    const messages: Message[] = [{ role: 'user', content: buildTaskPrompt(task) }]
    const maxIter = Math.max(1, opts.maxIterations ?? MAX_ITERATIONS)
    let final: string | null = null
    let truncated = false

    for (let i = 0; i < maxIter; i++) {
      if (cancelledTasks.has(taskId)) throw new CancelledError()

      const res = await complete(
        {
          provider,
          model: workspace.modelId,
          systemPrompt: AGENT_SYSTEM_PROMPT,
          messages,
          maxTokens: MAX_OUTPUT_TOKENS,
          ...(tools.length > 0 ? { tools } : {}),
        },
        apiKey,
      )
      totalIn += res.inputTokens
      totalOut += res.outputTokens
      totalCost += res.costCents
      addTraceEvent(trace.id, {
        type: 'llm_call',
        payload: { model: res.model, provider: res.provider, stopReason: res.stopReason, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costCents: res.costCents },
        durationMs: res.durationMs,
      })
      recordUsage(workspace.id, task.projectId, res.inputTokens + res.outputTokens, res.costCents)

      const calls = res.toolCalls ?? []
      if (tools.length > 0 && calls.length > 0) {
        // Guardrail: stop before spending more, but keep what we have (graceful, not a failure).
        if (overHardCap(workspace.id)) { truncated = true; final = res.content.trim(); break }
        messages.push({ role: 'assistant', content: res.content.trim(), toolCalls: calls })
        const results: ToolResult[] = []
        for (const call of calls) {
          if (cancelledTasks.has(taskId)) throw new CancelledError()
          addTraceEvent(trace.id, { type: 'tool_call', payload: { id: call.id, name: call.name, input: call.input } })
          const out = await executeAgentTool(call.name, call.input, ctx)
          addTraceEvent(trace.id, { type: 'tool_result', payload: { toolCallId: call.id, name: call.name, isError: out.isError, content: out.content.slice(0, 4000) } })
          results.push({ toolCallId: call.id, content: out.content, isError: out.isError })
        }
        messages.push({ role: 'user', content: '', toolResults: results })
        continue
      }

      // No tool calls → this is the final answer.
      final = res.content.trim()
      if (res.stopReason === 'max_tokens') truncated = true
      break
    }

    if (final === null) {
      // Ran out of iterations while still calling tools — never produced a deliverable.
      throw new Error(`Agent did not finish within ${maxIter} tool iterations.`)
    }
    if (truncated) addTraceEvent(trace.id, { type: 'checkpoint', payload: { truncated: true } })
    const deliverable = final || '(agent produced no textual deliverable — see the run trace for tool activity)'
    addTraceEvent(trace.id, { type: 'checkpoint', payload: { result: deliverable } })
    finish('completed', deliverable)
  } catch (err) {
    if (err instanceof CancelledError) {
      addTraceEvent(trace.id, { type: 'error', payload: { cancelled: true } })
      finish('cancelled', null)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    try { addTraceEvent(trace.id, { type: 'error', payload: { error: message } }) } catch { /* still finish below */ }
    finish('failed', null)
  }
}

function buildTaskPrompt(task: Task): string {
  const lines = [`Task: ${task.title}`]
  if (task.description) lines.push('', task.description)
  lines.push('', `Priority: ${task.priority}. Task id: ${task.id}. Project id: ${task.projectId}.`)
  return lines.join('\n')
}

// The DB `agent_workspaces.modelProvider` enum is a superset of the AI SDK's ModelProvider
// (it also has 'local'). Narrow a workspace provider to a supported one, or null.
function toModelProvider(p: AgentWorkspace['modelProvider']): ModelProvider | null {
  return isAisdkProvider(p) ? p : null
}

// ── Guardrails (per-workspace daily token/cost limits) ─────────────────────────

function today(): string {
  return new Date().toISOString().split('T')[0] ?? ''
}

// Increment the workspace's daily usage (resetting first if the day rolled over) and emit
// agent.cost.warning when a soft threshold is first crossed.
function recordUsage(workspaceId: string, projectId: string, tokens: number, costCents: number): void {
  const ws = getWorkspace(workspaceId)
  if (!ws) return
  const rolledOver = ws.tokensResetDate !== today()
  const prevTokens = rolledOver ? 0 : ws.tokensUsedToday
  const prevCost = rolledOver ? 0 : ws.costUsedTodayCents
  const newTokens = prevTokens + tokens
  const newCost = prevCost + costCents
  getDb()
    .update(agentWorkspaces)
    .set({ tokensUsedToday: newTokens, costUsedTodayCents: newCost, tokensResetDate: today(), updatedAt: new Date().toISOString() })
    .where(eq(agentWorkspaces.id, workspaceId))
    .run()

  const crossedTokenWarn = ws.dailyTokenLimit != null && prevTokens < ws.dailyTokenLimit * COST_WARN_RATIO && newTokens >= ws.dailyTokenLimit * COST_WARN_RATIO
  const crossedCostWarn = ws.dailyCostLimitCents != null && prevCost < ws.dailyCostLimitCents * COST_WARN_RATIO && newCost >= ws.dailyCostLimitCents * COST_WARN_RATIO
  if (crossedTokenWarn || crossedCostWarn) {
    logEvent(projectId, 'agent.cost.warning', 'agent', workspaceId, 'agent_workspace', workspaceId, {
      tokensUsedToday: newTokens, costUsedTodayCents: newCost, dailyTokenLimit: ws.dailyTokenLimit, dailyCostLimitCents: ws.dailyCostLimitCents,
    })
  }
}

function overHardCap(workspaceId: string): boolean {
  const ws = getWorkspace(workspaceId)
  if (!ws) return false
  if (ws.tokensResetDate !== today()) return false // fresh day → not over
  if (ws.dailyTokenLimit != null && ws.tokensUsedToday >= ws.dailyTokenLimit) return true
  if (ws.dailyCostLimitCents != null && ws.costUsedTodayCents >= ws.dailyCostLimitCents) return true
  return false
}

// ── Event helper (append-only log; every execution state change is an event) ───

function logEvent(
  projectId: string,
  type: string,
  actorType: 'agent' | 'system',
  actorId: string | null,
  resourceType: string,
  resourceId: string,
  payload: Record<string, unknown>,
): void {
  getDb()
    .insert(events)
    .values({
      id: generateId(),
      type,
      domain: 'agent-orchestration',
      projectId,
      actorType,
      actorId,
      resourceType,
      resourceId,
      payload: JSON.stringify(payload),
    })
    .run()
}
