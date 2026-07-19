import { Component, type ErrorInfo, type ReactNode } from 'react'

// App-wide crash net. Before this, any render-time exception unmounted the
// whole tree and left a blank white page — the designer's only recourse was to
// guess that a refresh might help, and nothing anywhere recorded that it had
// happened. React has no hook equivalent for componentDidCatch, so this stays
// a class component.
//
// Deliberately NOT a route-level boundary: a crash inside one page should not
// take the header with it, but wiring per-route boundaries means 20 mount
// points to keep in sync. One boundary just inside the router covers every
// page, and `resetKey` (fed the pathname) clears a caught error on navigation
// so a crash on one proof doesn't wedge the whole app.

interface Props {
  children: ReactNode
  /** Changing this clears a caught error — pass the current pathname. */
  resetKey?: string
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    // Navigating away from the crashed view clears it, so the app recovers
    // without a full reload.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console is the only sink today — there is no error-reporting service
    // wired into the frontend. Kept structured and prefixed so it is greppable
    // if one is added later, and so a designer can be asked to read it out.
    console.error('[ErrorBoundary] render crash', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas px-6 py-12">
        <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6">
          <h1 className="text-lg font-semibold text-ink">Something went wrong on this page</h1>
          <p className="mt-2 text-sm text-ink-mute">
            The page stopped unexpectedly. Nothing you had already saved is affected — but anything
            typed into a form and not yet saved will need re-entering.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="inline-flex h-[38px] max-md:min-h-[44px] items-center justify-center rounded-[4px] bg-ink px-4 text-sm font-medium text-on-ink transition-colors hover:bg-ink-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
            >
              Try again
            </button>
            <a
              href="/"
              className="inline-flex h-[38px] max-md:min-h-[44px] items-center justify-center rounded-[4px] border border-line bg-surface px-4 text-sm font-medium text-ink-soft transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
            >
              Back to Proofs
            </a>
          </div>
          <details className="mt-5">
            <summary className="cursor-pointer text-[13px] text-ink-mute">
              Technical detail (useful when reporting this)
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-canvas p-3 text-[11px] text-ink-mute">
              {error.message}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}
