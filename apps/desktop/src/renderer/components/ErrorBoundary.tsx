import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props { children: ReactNode }
interface State { error: Error | null }

// Catches render-time crashes anywhere below it and shows a recoverable error
// card instead of unmounting the whole tree (which renders a blank white screen).
// A single bad component must never take down the entire app.
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced in the dev console / main-process logs for diagnosis.
    console.error('[pm-os] Unhandled render error:', error, info.componentStack)
  }

  private handleDismiss = (): void => {
    // Navigate home and clear the error so the app re-renders a fresh route.
    window.location.hash = '#/reports'
    this.setState({ error: null })
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-background p-6 text-foreground">
          <div className="w-full max-w-md rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center">
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-destructive" aria-hidden="true" />
            <h1 className="text-base font-semibold text-foreground">Something went wrong</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A part of the app hit an unexpected error. Your data is safe — you can go back or reload.
            </p>
            <p className="mt-3 break-words rounded-md bg-background/60 px-3 py-2 text-left font-mono text-xs text-muted-foreground">
              {this.state.error.message}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button
                onClick={this.handleDismiss}
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Back to dashboard
              </button>
              <button
                onClick={this.handleReload}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
