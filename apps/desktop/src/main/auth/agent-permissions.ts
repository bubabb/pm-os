import type { AgentWorkspace } from '@pm-os/database'

interface PermissionScope {
  tools: string[]
  repos: string[]
  secrets: string[]
}

// Agents are deny-by-default. A resource is accessible only if explicitly listed in the scope.
export function validateAgentPermission(
  workspace: AgentWorkspace,
  resource: 'tool' | 'repo' | 'secret',
  resourceId: string,
): boolean {
  let scope: PermissionScope
  try {
    scope = JSON.parse(workspace.permissionScope) as PermissionScope
  } catch {
    return false
  }

  const key = `${resource}s` as keyof PermissionScope
  const allowed = scope[key]
  if (!Array.isArray(allowed)) return false

  // '*' grants access to all resources of this type
  if (allowed.includes('*')) return true
  return allowed.includes(resourceId)
}
