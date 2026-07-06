import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, destroyTestDb } from '@pm-os/database/testing'
import { createTool, publishVersion, getTool, listVersions, deploy, rollback, listDeployments } from './index'

let userId: string
let projectId: string

beforeEach(() => {
  ;({ userId, projectId } = seedWorkspace())
})
afterEach(() => destroyTestDb())

function publish(toolId: string, version: string) {
  return publishVersion(toolId, { version, schema: '{}', implementation: '{}' }, userId)
}
const activeDeployments = (toolId: string) => listDeployments(toolId).filter((d) => d.status === 'active')

describe('tool-registry', () => {
  it('creates a tool with no latest version', () => {
    const tool = createTool(projectId, { name: 'formatter' }, userId)
    expect(tool.name).toBe('formatter')
    expect(tool.latestVersionId).toBeNull()
    expect(getTool(tool.id)?.id).toBe(tool.id)
  })

  it('publishing repoints latestVersionId to the newest version', () => {
    const tool = createTool(projectId, { name: 't' }, userId)
    const v1 = publish(tool.id, '1.0.0')
    expect(getTool(tool.id)?.latestVersionId).toBe(v1.id)
    const v2 = publish(tool.id, '1.1.0')
    expect(getTool(tool.id)?.latestVersionId).toBe(v2.id)
    expect(listVersions(tool.id).map((v) => v.version)).toContain('1.0.0')
    expect(listVersions(tool.id)).toHaveLength(2)
  })

  it('keeps exactly one active deployment and records the superseded previous version', () => {
    const tool = createTool(projectId, { name: 't' }, userId)
    const v1 = publish(tool.id, '1.0.0')
    const v2 = publish(tool.id, '2.0.0')

    deploy(tool.id, v1.id, userId)
    expect(activeDeployments(tool.id)).toHaveLength(1)
    expect(activeDeployments(tool.id)[0]?.toolVersionId).toBe(v1.id)

    deploy(tool.id, v2.id, userId)
    const active = activeDeployments(tool.id)
    expect(active).toHaveLength(1)
    expect(active[0]?.toolVersionId).toBe(v2.id)
    expect(active[0]?.previousVersionId).toBe(v1.id)
    // the v1 deployment is superseded, not active and not rolled_back
    expect(listDeployments(tool.id).some((d) => d.status === 'superseded')).toBe(true)
  })

  it('rollback restores the previous version non-destructively', () => {
    const tool = createTool(projectId, { name: 't' }, userId)
    const v1 = publish(tool.id, '1.0.0')
    const v2 = publish(tool.id, '2.0.0')
    deploy(tool.id, v1.id, userId)
    deploy(tool.id, v2.id, userId)

    rollback(tool.id, userId)
    const active = activeDeployments(tool.id)
    expect(active).toHaveLength(1)
    expect(active[0]?.toolVersionId).toBe(v1.id)
    expect(listDeployments(tool.id).some((d) => d.status === 'rolled_back')).toBe(true)
  })

  it('rejects deploying a version that belongs to another tool', () => {
    const toolA = createTool(projectId, { name: 'a' }, userId)
    const toolB = createTool(projectId, { name: 'b' }, userId)
    const vB = publish(toolB.id, '1.0.0')
    expect(() => deploy(toolA.id, vB.id, userId)).toThrow()
  })

  it('rollback with no previous version throws', () => {
    const tool = createTool(projectId, { name: 't' }, userId)
    const v1 = publish(tool.id, '1.0.0')
    deploy(tool.id, v1.id, userId)
    expect(() => rollback(tool.id, userId)).toThrow()
  })
})
