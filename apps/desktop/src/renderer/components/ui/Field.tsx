import type { ReactNode } from 'react'

/**
 * Small form-field wrapper: a real <label htmlFor> above the control plus an
 * optional hint below. The child control must carry the matching `id`.
 */
export function Field({
  id, label, hint, children,
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
