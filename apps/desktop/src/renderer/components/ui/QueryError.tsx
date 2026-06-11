import { AlertCircle, RefreshCw } from 'lucide-react'

/** Inline error card for failed list queries — distinct from empty states. */
export function QueryError({
  message, onRetry,
}: {
  // Allow `undefined` explicitly: callers pass `err instanceof Error ? err.message : undefined`,
  // which exactOptionalPropertyTypes rejects against a bare `message?: string`.
  message?: string | undefined
  onRetry: () => void
}) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
      <AlertCircle className="mx-auto mb-2 h-6 w-6 text-destructive" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">Couldn&rsquo;t load data</p>
      <p className="mt-1 text-xs text-muted-foreground">{message ?? 'Something went wrong.'}</p>
      <button
        onClick={onRetry}
        className="mx-auto mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Retry
      </button>
    </div>
  )
}
