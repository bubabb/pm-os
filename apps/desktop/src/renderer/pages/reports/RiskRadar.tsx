import { Send } from 'lucide-react'
import type { ClassifiedItem } from '@creare/integrations'

const RISK_COLORS: Record<number, { bg: string; text: string; dot: string }> = {
  5: { bg: 'bg-destructive/10', text: 'text-destructive',        dot: 'bg-red-500' },
  4: { bg: 'bg-destructive/10', text: 'text-destructive',        dot: 'bg-red-500' },
  3: { bg: 'bg-yellow-500/10',  text: 'text-yellow-600 dark:text-yellow-400', dot: 'bg-amber-500' },
  2: { bg: 'bg-muted/40',       text: 'text-muted-foreground',   dot: 'bg-emerald-500' },
  1: { bg: 'bg-muted/40',       text: 'text-muted-foreground',   dot: 'bg-emerald-500' },
}

interface Props {
  risks: ClassifiedItem[]
  acknowledgedIds: Set<string>
  onHandle: (item: ClassifiedItem) => void
  onDelegate: (item: ClassifiedItem) => void
}

export function RiskRadar({ risks, acknowledgedIds, onHandle, onDelegate }: Props) {
  const visible = risks.filter(
    (i) => !acknowledgedIds.has(`${i.entity.source}-${i.entity.entityId}`),
  )

  return (
    <div className="border-t border-border">
      <div className="flex items-center justify-between px-6 py-3">
        <h2 className="text-sm font-semibold text-foreground">Risk Radar</h2>
        <span className="text-xs text-muted-foreground">{visible.length} active</span>
      </div>

      {visible.length === 0 ? (
        <p className="px-6 pb-4 text-sm text-muted-foreground">No risks detected.</p>
      ) : (
        <div className="divide-y divide-border/50 px-6 pb-4">
          {visible.map((item) => {
            const id = `${item.entity.source}-${item.entity.entityId}`
            const colors = RISK_COLORS[item.urgency] ?? RISK_COLORS[2]!

            return (
              <div key={id} className="flex items-start gap-4 py-3">
                <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center" title={`Urgency ${item.urgency}`}>
                  <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${colors.dot}`} />
                  <span className="sr-only">Urgency {item.urgency} of 5</span>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground line-clamp-1">{item.entity.title}</p>
                    {item.riskType && (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${colors.bg} ${colors.text}`}>
                        {item.riskType}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{item.suggestedAction}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => onHandle(item)}
                    title="Acknowledge and remove from the radar"
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={() => onDelegate(item)}
                    className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                  >
                    Delegate
                    <Send className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
