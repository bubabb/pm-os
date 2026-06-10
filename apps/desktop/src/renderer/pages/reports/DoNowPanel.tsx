import { CheckCircle } from 'lucide-react'
import type { ClassifiedItem } from '@creare/integrations'
import { Badge, BADGE_SOURCE_CLASSES, SOURCE_LABELS, type BadgeSource } from '../../components/ui/Badge'

function isBadgeSource(source: string): source is BadgeSource {
  return source in BADGE_SOURCE_CLASSES
}

/** Colored status dot (replaces emoji glyphs so screen readers stay quiet). */
function UrgencyBadge({ urgency }: { urgency: number }) {
  const dot = urgency >= 4 ? 'bg-red-500' : urgency === 3 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center" title={`Urgency ${urgency}`}>
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dot}`} />
      <span className="sr-only">Urgency {urgency} of 5</span>
    </span>
  )
}

interface Props {
  items: ClassifiedItem[]
  acknowledgedIds: Set<string>
  onAcknowledge: (id: string) => void
}

export function DoNowPanel({ items, acknowledgedIds, onAcknowledge }: Props) {
  const visible = items.filter(
    (i) => !acknowledgedIds.has(`${i.entity.source}-${i.entity.entityId}`),
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Do Now</h2>
        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
          {visible.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <CheckCircle className="mx-auto mb-2 h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">All clear</p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {visible.map((item) => {
              const id = `${item.entity.source}-${item.entity.entityId}`
              return (
                <li key={id} className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/20">
                  <UrgencyBadge urgency={item.urgency} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Badge
                          {...(isBadgeSource(item.entity.source) ? { source: item.entity.source } : {})}
                          className="mb-1"
                        >
                          {isBadgeSource(item.entity.source) ? SOURCE_LABELS[item.entity.source] : item.entity.source}
                        </Badge>
                        <p className="text-sm font-medium leading-tight text-foreground line-clamp-2">
                          {item.entity.title}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{item.suggestedAction}</p>
                      </div>
                      <button
                        onClick={() => onAcknowledge(id)}
                        className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
                        title="Acknowledge"
                        aria-label={`Acknowledge ${item.entity.title}`}
                      >
                        <CheckCircle className="h-4 w-4" />
                      </button>
                    </div>
                    {item.entity.entityUrl && (
                      <a
                        href={item.entity.entityUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 text-[11px] text-primary/70 hover:text-primary hover:underline"
                      >
                        Open ↗
                      </a>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
