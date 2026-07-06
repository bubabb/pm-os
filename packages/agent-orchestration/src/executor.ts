// Agent execution runtime — actually RUNS an agent task: binds/activates a workspace,
// opens an observability trace, drives a think→act→observe loop over the ai-sdk (with
// tools when the provider supports them, single-step otherwise), enforces per-workspace
// daily cost/token guardrails, stores the deliverable on the task + trace, and emits
// the contract execution events. Deliberately provider-agnostic: the model + provider
// come from the workspace; keyed providers get their key via an injected resolver.
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

// ── Config (env-tunable, sane defaults) ───────────────────────────────────────
const DEFAULT_PROVIDER = (process.env['PMOS_AGENT_PROVIDER'] as ModelProvider) || 'claude-cli'
const DEFAULT_MODEL = process.env['PMOS_AGENT_MODEL'] || 'claude-haiku-4-5-20251001'
const MAX_ITERATIONS = Number(process.env['PMOS_AGENT_MAX_ITERATIONS']) || 8
const COST_WARN_RATIO = 0.8 // soft-warn at 80% of a daily limit

const DEFAULT_WORKSPACE_NAME = 'Default Agent'

const AGENT_SYSTEM_PROMPT = [
  'You are an autonomous DevOps agent inside Pm.Os working a single delegated task.',
  'Use the available tools to inspect the project when it helps. When you have done the work,',
  'reply with a concise, concrete DELIVERABLE: what you found/did and any recommended follow-up.',
  'Do not ask the user questions — produce the best result you can from the task and tools.',
].join(' ')

class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

// Tasks a caller asked to cancel while running. The loop checks this between steps.
const cancelledTasks = new Set<string>()

export interface ExecuteTaskOptions {
  // Resolve an API key for a keyed provider (anthropic/openai/gemini). claude-cli needs
  // none. Injected by the caller (apps/desktop owns secrets); defaults to no key.
  resolveApiKey?: (provider: ModelProvider) => Promise<string> | string
  maxIterations?: number
}

// ── Public API (fulfils CONTRACT.md: startTask / cancelTask) ──────────────────

// Run a single agent task to completion (or failure). Safe to call from a worker loop;
// claims the task atomically so concurrent callers can't double-run it. Resolves when the
// run finishes; never throws (failures are recorded on the task + trace).
export async function startTask(taskId: string, opts: ExecuteTaskOptions = {}): Promise<Task | null> {
  const task = getTask(taskId)
  if (!task) return null
  if (task.type !== 'agent') return task // only agent tasks are executed
  if (!claimTask(taskId)) return getTask(taskId) // not pending / already claimed

  cancelledTasks.delete(taskId)
  try {
    await runTask(taskId, opts)
  } catch (err) {
    // runTask handles its own failures; this is a last-resort guard so the worker loop
    // never sees an exception.
    console.error(`[agent] unhandled error running task ${taskId}:`, err)
  }
  return getTask(taskId)
}

// Request cancellation. A queued (pending) task is cancelled immediately; a running task
// stops at its next loop checkpoint and is marked cancelled by runTask.
export function cancelTask(taskId: string): Task | null {
  const task = getTask(taskId)
  if (!task) return null
  cancelledTasks.add(taskId)
  if (task.status === 'pending') {
    return updateTask(taskId, { status: 'cancelled' }) ?? null
  }
  return task // in_progress: the loop will observe the flag and finish as cancelled
}

// Reset agent tasks left 'in_progress' by a crash back to 'pending' (and fail their open
// traces), so they re-run on the next worker tick. Call once at worker startup.
export function recoverStaleAgentTasks(): number {
  const db = getDb()
  const stale = db.select().from(tasks).where(and(eq(tasks.type, 'agent'), eq(tasks.status, 'in_progress'))).all()
  if (stale.length === 0) return 0
  const now = new Date().toISOString()
  const ids = stale.map((t) => t.id)
  db.update(tasks).set({ status: 'pending', startedAt: null, updatedAt: now }).where(inArray(tasks.id, ids)).run()
  // Fail any still-'running' traces for these tasks.
  db.update(traces).set({ status: 'failed', completedAt: now }).where(and(inArray(traces.taskId, ids), eq(traces.status, 'running'))).run()
  return stale.length
}

// ── Internals ─────────────────────────────────────────────────────────────────

// Atomic claim: pending → in_progress only if still pending (guards double-run).
function claimTask(taskId: string): boolean {
  const now = new Date().toISOString()
  const res = getDb()
    .update(tasks)
    .set({ status: 'in_progress', startedAt: now, updatedAt: now })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')))
    .run()
  if (res.changes === 1) {
    const task = getTask(taskId)
    if (task) logEvent(task.projectId, 'task.started', 'agent', task.agentWorkspaceId, 'task', taskId, { taskId })
  }
  return res.changes === 1
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

// The DB `agent_workspaces.modelProvider` enum is a superset of the AI SDK's ModelProvider
// (it also has 'local'). Narrow a workspace provider to a supported one, or null.
const AISDK_PROVIDERS: readonly ModelProvider[] = ['anthropic', 'openai', 'gemini', 'claude-cli']
function toModelProvider(p: AgentWorkspace['modelProvider']): ModelProvider | null {
  return (AISDK_PROVIDERS as readonly string[]).includes(p) ? (p as ModelProvider) : null
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

async function runTask(taskId: string, opts: ExecuteTaskOptions): Promise<void> {
  const task = getTask(taskId)!
  const workspace = task.agentWorkspaceId ? getWorkspace(task.agentWorkspaceId) ?? getOrCreateDefaultWorkspace(task.projectId) : getOrCreateDefaultWorkspace(task.projectId)
  if (task.agentWorkspaceId !== workspace.id) updateTask(taskId, { agentWorkspaceId: workspace.id })
  updateWorkspaceStatus(workspace.id, 'running')
  logEvent(task.projectId, 'agent.workspace.activated', 'agent', workspace.id, 'agent_workspace', workspace.id, { taskId })

  const trace = createTrace({ agentWorkspaceId: workspace.id, projectId: task.projectId, taskId })
  const startedMs = Date.now()
  let totalIn = 0
  let totalOut = 0
  let totalCost = 0

  const finish = (status: 'completed' | 'failed' | 'cancelled', result: string | null, errorMsg?: string): void => {
    updateTrace(trace.id, {
      status: status === 'completed' ? 'completed' : 'failed',
      inputTokens: totalIn,
      outputTokens: totalOut,
      costCents: totalCost,
      durationMs: Date.now() - startedMs,
      completedAt: new Date().toISOString(),
    })
    updateWorkspaceStatus(workspace.id, 'idle')
    updateTask(taskId, { status, ...(result !== null ? { result } : {}) }, workspace.id)
    if (status === 'completed') {
      logEvent(task.projectId, 'task.completed', 'agent', workspace.id, 'task', taskId, { taskId, durationMs: Date.now() - startedMs, costCents: totalCost })
    } else if (status === 'failed') {
      logEvent(task.projectId, 'task.failed', 'agent', workspace.id, 'task', taskId, { taskId, error: errorMsg ?? 'unknown error' })
    }
  }

  try {
    // The DB enum allows 'local', which the AI SDK doesn't support — narrow it or fail.
    const provider = toModelProvider(workspace.modelProvider)
    if (!provider) {
      throw new Error(`Workspace model provider '${workspace.modelProvider}' is not supported by the AI SDK.`)
    }
    // Guardrail pre-check + key resolution.
    const apiKey = providerNeedsKey(provider) ? String((await opts.resolveApiKey?.(provider)) ?? '') : ''
    if (!llmAvailable(provider, apiKey)) {
      throw new Error(`No LLM available for provider '${provider}' (missing API key or the claude CLI is not logged in).`)
    }
    if (overHardCap(workspace.id)) {
      throw new Error('Daily cost/token guardrail already reached for this agent workspace.')
    }

    const ctx: ToolContext = { projectId: task.projectId, actorId: workspace.id, allowedTools: parseAllowedTools(workspace.permissionScope) }
    const tools = supportsTools(provider) ? listAgentTools(ctx) : []

    const messages: Message[] = [{ role: 'user', content: buildTaskPrompt(task) }]
    let final = ''
    const maxIter = opts.maxIterations ?? MAX_ITERATIONS

    for (let i = 0; i < maxIter; i++) {
      if (cancelledTasks.has(taskId)) throw new CancelledError()

      const res = await complete(
        {
          provider,
          model: workspace.modelId,
          systemPrompt: AGENT_SYSTEM_PROMPT,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        },
        apiKey,
      )
      totalIn += res.inputTokens
      totalOut += res.outputTokens
      totalCost += res.costCents
      addTraceEvent(trace.id, {
        type: 'llm_call',
        payload: { model: res.model, provider: res.provider, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costCents: res.costCents },
        durationMs: res.durationMs,
      })
      recordUsage(workspace.id, task.projectId, res.inputTokens + res.outputTokens, res.costCents)
      if (overHardCap(workspace.id)) throw new Error('Daily cost/token guardrail exceeded mid-run — stopping the agent.')

      const calls = res.toolCalls ?? []
      if (tools.length > 0 && calls.length > 0) {
        messages.push({ role: 'assistant', content: res.content, toolCalls: calls })
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

      final = res.content.trim()
      break
    }

    if (!final) final = '(agent produced no textual deliverable — see the run trace for tool activity)'
    addTraceEvent(trace.id, { type: 'checkpoint', payload: { result: final } })
    finish('completed', final)
  } catch (err) {
    if (err instanceof CancelledError) {
      addTraceEvent(trace.id, { type: 'error', payload: { cancelled: true } })
      finish('cancelled', null)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    addTraceEvent(trace.id, { type: 'error', payload: { error: message } })
    finish('failed', null, message)
  }
}

function buildTaskPrompt(task: Task): string {
  const lines = [`Task: ${task.title}`]
  if (task.description) lines.push('', task.description)
  lines.push('', `Priority: ${task.priority}. Task id: ${task.id}. Project id: ${task.projectId}.`)
  return lines.join('\n')
}

// ── Guardrails (per-workspace daily token/cost limits) ─────────────────────────

function today(): string {
  return new Date().toISOString().split('T')[0] ?? ''
}

// Increment the workspace's daily usage (resetting first if the day rolled over) and
// emit agent.cost.warning when a soft threshold is first crossed.
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
