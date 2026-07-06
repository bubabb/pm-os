// ── Safe, permission-scoped tool executor ────────────────────────────────────
//
// The agent-execution runtime hands a running agent a bounded set of built-in
// tools. Every tool here is SAFE by construction: no shell, no filesystem, no
// network, no arbitrary code — each one only reads/writes the project's own rows
// through the existing agent-orchestration helpers, always scoped to
// `ctx.projectId`. Permissions are deny-by-default: a tool runs only when its
// name is in `ctx.allowedTools` (or `allowedTools` is the wildcard `'*'`).

import { createTask, getTask, listTasks } from './index'
import type { Task, CreateTaskParams } from './index'

// ── Public types ──────────────────────────────────────────────────────────────

export interface ToolContext {
  projectId: string
  actorId: string // the agent workspace id (used as event actorId, actorType 'agent')
  allowedTools: string[] | '*' // from workspace.permissionScope.tools; deny-by-default; '*' = all built-ins
}

// JSON-Schema-shaped tool descriptor. Matches the ai-sdk tool shape so the
// runtime can forward these straight into complete({ tools }).
export interface AgentToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolResult {
  content: string
  isError: boolean
}

// ── Internal tool definition ────────────────────────────────────────────────

interface BuiltInTool {
  schema: AgentToolSchema
  // Executes the tool. Throws ToolInputError for invalid input (caught centrally
  // and turned into an isError result); returns the success content string.
  run: (input: Record<string, unknown>, ctx: ToolContext) => string
}

// Thrown for validation failures so dispatch can convert it to an isError result
// instead of letting it escape to the runtime.
class ToolInputError extends Error {}

const TASK_STATUSES = [
  'pending',
  'in_progress',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const
type TaskStatus = (typeof TASK_STATUSES)[number]

const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
type Priority = (typeof PRIORITIES)[number]

// ── Input validation helpers ─────────────────────────────────────────────────

function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ToolInputError(`'${key}' is required and must be a non-empty string`)
  }
  return v
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ToolInputError(`'${key}' must be a string`)
  return v
}

function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = input[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new ToolInputError(`'${key}' must be one of: ${allowed.join(', ')}`)
  }
  return v as T
}

// Compact projection returned by task-listing tools.
function projectTask(t: Task): {
  id: string
  title: string
  status: string
  type: string
  priority: string
} {
  return { id: t.id, title: t.title, status: t.status, type: t.type, priority: t.priority }
}

// ── Built-in tool registry ───────────────────────────────────────────────────

const BUILT_IN_TOOLS: Record<string, BuiltInTool> = {
  list_tasks: {
    schema: {
      name: 'list_tasks',
      description:
        "List this project's tasks, optionally filtered by status. Returns a compact JSON array of { id, title, status, type, priority }.",
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...TASK_STATUSES],
            description: 'Optional status filter.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    run: (input, ctx) => {
      const status = optionalEnum<TaskStatus>(input, 'status', TASK_STATUSES)
      const rows = listTasks(ctx.projectId, status ? { status } : undefined)
      return JSON.stringify(rows.map(projectTask))
    },
  },

  get_task: {
    schema: {
      name: 'get_task',
      description:
        "Fetch a single task in this project by id. Returns the task's fields as JSON, or an error if the task does not belong to this project.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task id to fetch.' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
    run: (input, ctx) => {
      const taskId = requireString(input, 'taskId')
      const task = getTask(taskId)
      // No cross-project access: a missing task and a foreign task are
      // indistinguishable to the agent — both are "not found in this project".
      if (!task || task.projectId !== ctx.projectId) {
        throw new ToolInputError(`Task not found in this project: ${taskId}`)
      }
      return JSON.stringify({
        id: task.id,
        title: task.title,
        description: task.description,
        type: task.type,
        status: task.status,
        priority: task.priority,
        assigneeId: task.assigneeId,
        agentWorkspaceId: task.agentWorkspaceId,
        startDate: task.startDate,
        dueDate: task.dueDate,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })
    },
  },

  get_project_summary: {
    schema: {
      name: 'get_project_summary',
      description:
        "Summarize this project's tasks: total count and a breakdown of task counts by status.",
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    run: (_input, ctx) => {
      const rows = listTasks(ctx.projectId)
      const byStatus: Record<string, number> = {}
      for (const status of TASK_STATUSES) byStatus[status] = 0
      for (const t of rows) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
      return JSON.stringify({ total: rows.length, byStatus })
    },
  },

  create_followup_task: {
    schema: {
      name: 'create_followup_task',
      description:
        'Propose a human follow-up task in this project. Creates a HUMAN task (status pending) and returns its new id.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the follow-up task.' },
          description: { type: 'string', description: 'Optional longer description.' },
          priority: {
            type: 'string',
            enum: [...PRIORITIES],
            description: 'Optional priority (default medium).',
          },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    run: (input, ctx) => {
      const title = requireString(input, 'title')
      const description = optionalString(input, 'description')
      const priority = optionalEnum<Priority>(input, 'priority', PRIORITIES)
      // Build params without undefined keys (exactOptionalPropertyTypes is on).
      const params: CreateTaskParams = { title, type: 'human' }
      if (description !== undefined) params.description = description
      if (priority !== undefined) params.priority = priority
      // createTask emits its own task.created event; the agent workspace is the actor.
      const task = createTask(ctx.projectId, params, ctx.actorId, 'agent')
      return JSON.stringify({ taskId: task.id, status: task.status })
    },
  },
}

// ── Permission gate ──────────────────────────────────────────────────────────

function isAllowed(name: string, ctx: ToolContext): boolean {
  if (ctx.allowedTools === '*') return true
  return ctx.allowedTools.includes(name)
}

// ── Public API ───────────────────────────────────────────────────────────────

// The built-in tools available to this context, filtered by allowedTools
// (deny-by-default; '*' grants all built-ins). The runtime forwards the returned
// schemas straight into complete({ tools }).
export function listAgentTools(ctx: ToolContext): AgentToolSchema[] {
  return Object.values(BUILT_IN_TOOLS)
    .filter((tool) => isAllowed(tool.schema.name, ctx))
    .map((tool) => tool.schema)
}

// Permission-checked dispatch. Never throws — an unknown tool, a denied tool, or
// bad input all resolve to { isError: true } so the runtime can feed the message
// straight back to the model. The permission is re-checked here so a tool that
// isn't allowed never runs, even if invoked directly.
export async function executeAgentTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = BUILT_IN_TOOLS[name]
  if (!tool) {
    return { content: `Unknown tool: ${name}`, isError: true }
  }
  if (!isAllowed(name, ctx)) {
    return { content: `Tool not permitted: ${name}`, isError: true }
  }
  try {
    const content = tool.run(input ?? {}, ctx)
    return { content, isError: false }
  } catch (err) {
    if (err instanceof ToolInputError) {
      return { content: err.message, isError: true }
    }
    // Any unexpected error is still returned as an isError result — never thrown —
    // so a runtime consuming the model loop stays alive.
    const message = err instanceof Error ? err.message : String(err)
    return { content: `Tool '${name}' failed: ${message}`, isError: true }
  }
}
