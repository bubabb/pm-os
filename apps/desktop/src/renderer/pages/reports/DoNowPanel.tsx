import { CheckCircle } from 'lucide-react'
import type { ClassifiedItem } from '@creare/integrations'

const SOURCE_LABELS: Record<string, string> = {
  jira: 'Jira', github: 'GitHub', confluence: 'Confluence',
  notion: 'Notion', onedrive: 'OneDrive',
}

const SOURCE_COLORS: Record<string, string> = {
  jira:       'bg-blue-500/10 text-blue-400',
  github:     'bg-purple-500/10 text-purple-400',
  confluence: 'bg-teal-500/10 text-teal-400',
  notion:     'bg-gray-500/10 text-gray-400',
  onedrive:   'bg-sky-500/10 text-sky-400',
}

function UrgencyBadge({ urgency }: { urgency: number }) {
  if (urgency >= 4) return <span className="text-base" title={`Urgency ${urgency}`}>🔴</span>
  if (urgency === 3) return <span className="text-base" title={`Urgency ${urgency}`}>🟡</span>
  return <span className="text-base" title={`Urgency ${urgency}`}>🟢</span>
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
                        <span
                          className={`mb-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${SOURCE_COLORS[item.entity.source] ?? 'bg-muted text-muted-foreground'}`}
                        >
                          {SOURCE_LABELS[item.entity.source] ?? item.entity.source}
                        </span>
                        <p className="text-sm font-medium leading-tight text-foreground line-clamp-2">
                          {item.entity.title}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{item.suggestedAction}</p>
                      </div>
                      <button
                        onClick={() => onAcknowledge(id)}
                        className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
                        title="Acknowledge"
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
