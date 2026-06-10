import type { ReactNode } from 'react'

// ── Shared badge / chip component ─────────────────────────────────────────────
// Single source of truth for status + source chips, tuned for the dark theme
// (≥4.5:1 contrast on bg-card/bg-background): tinted translucent backgrounds
// with light -300/-400 text.

export type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info'
export type BadgeSource = 'github' | 'jira' | 'confluence' | 'notion' | 'onedrive'

export const BADGE_VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'bg-zinc-500/15 text-zinc-300',
  success: 'bg-emerald-500/15 text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-300',
  danger:  'bg-red-500/15 text-red-300',
  info:    'bg-blue-500/15 text-blue-300',
}

/** Per-source chip colors — normalized app-wide (GitHub is purple everywhere). */
export const BADGE_SOURCE_CLASSES: Record<BadgeSource, string> = {
  github:     'bg-purple-500/15 text-purple-300',
  jira:       'bg-blue-500/15 text-blue-300',
  confluence: 'bg-teal-500/15 text-teal-300',
  notion:     'bg-zinc-500/15 text-zinc-300',
  onedrive:   'bg-sky-500/15 text-sky-300',
}

export const SOURCE_LABELS: Record<BadgeSource, string> = {
  github: 'GitHub', jira: 'Jira', confluence: 'Confluence', notion: 'Notion', onedrive: 'OneDrive',
}

interface BadgeProps {
  variant?: BadgeVariant
  /** When set, overrides `variant` with the per-source color map. */
  source?: BadgeSource
  className?: string
  title?: string
  children: ReactNode
}

export function Badge({ variant = 'neutral', source, className = '', title, children }: BadgeProps) {
  const colors = source ? BADGE_SOURCE_CLASSES[source] : BADGE_VARIANT_CLASSES[variant]
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${colors} ${className}`}
    >
      {children}
    </span>
  )
}
