// Tool Registry — Domain 2 public API
// Versioned AI tool artifacts: register tools, publish immutable versions,
// deploy a version to "active", and roll back to the previous deployed version.
// Every state change emits an event to the append-only event log (see CONTRACT.md).

import { getDb, tools, toolVersions, toolDeployments, events } from '@pm-os/database'
import { eq, and, desc } from 'drizzle-orm'
import { generateId } from '@pm-os/shared'
import type { InferSelectModel } from 'drizzle-orm'

// ── Re-exported types ─────────────────────────────────────────────────────────

export type Tool           = InferSelectModel<typeof tools>
export type ToolVersion    = InferSelectModel<typeof toolVersions>
export type ToolDeployment = InferSelectModel<typeof toolDeployments>

// ── Tool management ─────────────────────────────────────────────────────────────

export interface CreateToolParams {
  name: string
  description?: string
}

export function listTools(projectId: string): Tool[] {
  return getDb().select().from(tools).where(eq(tools.projectId, projectId)).all()
}

export function getTool(id: string): Tool | null {
  const [t] = getDb().select().from(tools).where(eq(tools.id, id)).limit(1).all()
  return t ?? null
}

export function createTool(projectId: string, params: CreateToolParams, createdById: string): Tool {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(tools).values({
    id, projectId,
    name: params.name,
    description: params.description ?? null,
    createdById,
    latestVersionId: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  _logEvent(projectId, 'tool.created', 'user', createdById, 'tool', id, { toolId: id, projectId, name: params.name })
  return getTool(id)!
}

// ── Version management ──────────────────────────────────────────────────────────

export interface PublishVersionParams {
  version: string                 // semver, e.g. "1.2.3"
  schema: string                  // JSON: input/output schema
  implementation: string          // JSON: implementation config
  changelog?: string
}

export function listVersions(toolId: string): ToolVersion[] {
  return getDb()
    .select()
    .from(toolVersions)
    .where(eq(toolVersions.toolId, toolId))
    .orderBy(desc(toolVersions.createdAt))
    .all()
}

export function getToolVersion(versionId: string): ToolVersion | null {
  const [v] = getDb().select().from(toolVersions).where(eq(toolVersions.id, versionId)).limit(1).all()
  return v ?? null
}

// Publishes an immutable new version and points the tool's latestVersionId at it.
export function publishVersion(toolId: string, params: PublishVersionParams, publishedById: string): ToolVersion {
  const tool = getTool(toolId)
  if (!tool) throw new Error(`Tool not found: ${toolId}`)

  const id = generateId()
  const db = getDb()
  // Insert + latestVersionId repoint are atomic so a failure can't leave the pointer
  // dangling at a version row that wasn't written.
  db.transaction(() => {
    db.insert(toolVersions).values({
      id, toolId,
      version: params.version,
      schema: params.schema,
      implementation: params.implementation,
      changelog: params.changelog ?? null,
      publishedById,
    }).run()
    // latestVersionId is a "newest published" pointer, independent of what is deployed.
    db.update(tools).set({ latestVersionId: id, updatedAt: new Date().toISOString() }).where(eq(tools.id, toolId)).run()
  })

  _logEvent(tool.projectId, 'tool.version.published', 'user', publishedById, 'tool_version', id, {
    toolId, versionId: id, version: params.version, publishedBy: publishedById,
  })
  return getToolVersion(id)!
}

// ── Deployment management ───────────────────────────────────────────────────────

export function listDeployments(toolId: string): ToolDeployment[] {
  return getDb()
    .select()
    .from(toolDeployments)
    .where(eq(toolDeployments.toolId, toolId))
    .orderBy(desc(toolDeployments.createdAt))
    .all()
}

// The single currently-active deployment for a tool, if any.
export function getActiveDeployment(toolId: string): ToolDeployment | null {
  const [d] = getDb().select().from(toolDeployments)
    .where(and(eq(toolDeployments.toolId, toolId), eq(toolDeployments.status, 'active')))
    .limit(1)
    .all()
  return d ?? null
}

// Deploys a version to active. Supersedes any currently-active deployment and records
// the superseded version as previousVersionId so rollback() can restore it.
export function deploy(toolId: string, versionId: string, deployedById: string): ToolDeployment {
  const tool = getTool(toolId)
  if (!tool) throw new Error(`Tool not found: ${toolId}`)
  const version = getToolVersion(versionId)
  if (!version || version.toolId !== toolId) throw new Error(`Version ${versionId} does not belong to tool ${toolId}`)

  const db = getDb()
  const current = getActiveDeployment(toolId)
  const now = new Date().toISOString()
  const id = generateId()

  // Supersede the prior active deployment (single-active invariant) and insert the new
  // one atomically, so a failure can't leave zero — or two — active deployments.
  // 'superseded' is distinct from 'rolled_back' so history doesn't mislabel forward deploys.
  db.transaction(() => {
    if (current) {
      db.update(toolDeployments).set({ status: 'superseded', updatedAt: now }).where(eq(toolDeployments.id, current.id)).run()
    }
    db.insert(toolDeployments).values({
      id, toolId,
      toolVersionId: versionId,
      projectId: tool.projectId,
      status: 'active',
      deployedById,
      previousVersionId: current?.toolVersionId ?? null,
      createdAt: now,
      updatedAt: now,
    }).run()
  })

  _logEvent(tool.projectId, 'tool.deployed', 'user', deployedById, 'tool_deployment', id, { toolId, versionId, deploymentId: id })
  return db.select().from(toolDeployments).where(eq(toolDeployments.id, id)).limit(1).all()[0]!
}

// Rolls the active deployment back to its previousVersionId. Never destructive —
// creates a new active deployment pointing at the old version.
export function rollback(toolId: string, deployedById: string): ToolDeployment {
  const tool = getTool(toolId)
  if (!tool) throw new Error(`Tool not found: ${toolId}`)

  const current = getActiveDeployment(toolId)
  if (!current) throw new Error(`No active deployment for tool ${toolId}`)
  if (!current.previousVersionId) throw new Error(`No previous version to roll back to for tool ${toolId}`)

  const db = getDb()
  const now = new Date().toISOString()
  const toVersionId = current.previousVersionId
  const fromVersionId = current.toolVersionId
  const id = generateId()

  // Restore the chain: what was `toVersionId`'s previous the last time it was active?
  const restoredPrev = _previousVersionLastRecordedFor(toolId, toVersionId)

  // Mark the current active rolled_back and insert the restored deployment atomically.
  db.transaction(() => {
    db.update(toolDeployments).set({ status: 'rolled_back', updatedAt: now }).where(eq(toolDeployments.id, current.id)).run()
    db.insert(toolDeployments).values({
      id, toolId,
      toolVersionId: toVersionId,
      projectId: tool.projectId,
      status: 'active',
      deployedById,
      previousVersionId: restoredPrev,
      createdAt: now,
      updatedAt: now,
    }).run()
  })

  _logEvent(tool.projectId, 'tool.rolled_back', 'user', deployedById, 'tool_deployment', id, {
    toolId, fromVersionId, toVersionId, deploymentId: id,
  })
  return db.select().from(toolDeployments).where(eq(toolDeployments.id, id)).limit(1).all()[0]!
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// The previousVersionId recorded the last time `versionId` was deployed — keeps
// rollback chains coherent across repeated rollbacks.
function _previousVersionLastRecordedFor(toolId: string, versionId: string): string | null {
  const [prior] = getDb().select().from(toolDeployments)
    .where(and(eq(toolDeployments.toolId, toolId), eq(toolDeployments.toolVersionId, versionId)))
    .orderBy(desc(toolDeployments.createdAt))
    .limit(1)
    .all()
  return prior?.previousVersionId ?? null
}

function _logEvent(
  projectId: string,
  type: string,
  actorType: 'user' | 'agent' | 'system',
  actorId: string | null,
  resourceType: string,
  resourceId: string,
  payload: Record<string, unknown>,
): void {
  getDb().insert(events).values({
    id: generateId(),
    type,
    domain: 'tool-registry',
    projectId,
    actorType,
    actorId,
    resourceType,
    resourceId,
    payload: JSON.stringify(payload),
  }).run()
}
