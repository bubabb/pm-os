import { Loader2 } from 'lucide-react'

// ── Shared loading spinner ────────────────────────────────────────────────────
// Hoists the `Loader2 h-5 w-5 animate-spin text-muted-foreground` pattern that
// was duplicated across every page's loading state.

export type SpinnerSize = 'sm' | 'md' | 'lg'

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
}

interface SpinnerProps {
  /** Icon size — sm (3.5), md (5, default), lg (6). */
  size?: SpinnerSize
  /** Render just the spinning icon (for buttons / inline rows) instead of the centered block. */
  inline?: boolean
  className?: string
}

/**
 * Default: the centered loading block used by page query states.
 * With `inline`, renders only the spinning icon so it can sit inside buttons.
 */
export function Spinner({ size = 'md', inline = false, className = '' }: SpinnerProps) {
  const icon = (
    <Loader2
      className={`${SIZE_CLASSES[size]} animate-spin text-muted-foreground ${className}`}
      aria-hidden="true"
    />
  )
  if (inline) return icon
  return (
    <div role="status" aria-label="Loading" className="flex h-32 items-center justify-center">
      {icon}
    </div>
  )
}
