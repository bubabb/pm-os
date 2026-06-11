// ── Shared date formatting helpers ────────────────────────────────────────────
// Single source of truth for the "Jun 11, 2026" style used across pages.

/** "Jun 11, 2026" — matches the per-page formatters this replaces. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Compact relative time: "just now", "5m ago", "2h ago", "3d ago".
 * Falls back to `formatDate` for anything older than a week, future
 * timestamps, or unparseable input.
 */
export function formatRelative(iso: string): string {
  const elapsedMs = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(elapsedMs) || elapsedMs < 0) return formatDate(iso)

  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  return formatDate(iso)
}
