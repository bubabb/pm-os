interface Props { title: string }

export default function Placeholder({ title }: Props) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">This domain is coming in Phase 2.</p>
      </div>
    </div>
  )
}
