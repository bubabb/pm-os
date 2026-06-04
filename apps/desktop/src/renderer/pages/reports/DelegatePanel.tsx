import { Bot, ChevronRight } from 'lucide-react'
import type { ClassifiedItem } from '@creare/integrations'

const SOURCE_LABELS: Record<string, string> = {
  jira: 'Jira', github: 'GitHub', confluence: 'Confluence',
  notion: 'Notion', onedrive: 'OneDrive',
}

interface Props {
  items: ClassifiedItem[]
  acknowledgedIds: Set<string>
  onDelegate: (item: ClassifiedItem) => void
}

export function DelegatePanel({ items, acknowledgedIds, onDelegate }: Props) {
  const visible = items.filter(
    (i) => !acknowledgedIds.has(`${i.entity.source}-${i.entity.entityId}`),
  )

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Delegate to Agent</h2>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {visible.length}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">No delegatable actions right now.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {visible.map((item) => {
            const id = `${item.entity.source}-${item.entity.entityId}`
            return (
              <li key={id} className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/20">
                <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary/60" />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {SOURCE_LABELS[item.entity.source] ?? item.entity.source}
                  </p>
                  <p className="text-sm font-medium text-foreground line-clamp-1">{item.entity.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{item.suggestedAction}</p>
                </div>
                <button
                  onClick={() => onDelegate(item)}
                  className="mt-0.5 flex shrink-0 items-center gap-0.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
                >
                  Delegate <ChevronRight className="h-3 w-3" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
