import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { FolderOpen } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

// ── Shared empty states ───────────────────────────────────────────────────────
// Dashed-border card for "nothing here yet" — distinct from QueryError.

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  /** Optional call-to-action rendered below the description. */
  action?: ReactNode
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      <Icon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

/**
 * Ready-made empty state for domain pages when no project is selected.
 * Drop in as the page body: `if (!currentProject) return <NoProject />`.
 */
export function NoProject() {
  const navigate = useNavigate()
  return (
    <div className="p-6">
      <EmptyState
        icon={FolderOpen}
        title="No project selected"
        description="Choose or create a project to get started."
        action={
          <button
            onClick={() => navigate('/projects')}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go to projects
          </button>
        }
      />
    </div>
  )
}
