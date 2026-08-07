import React from 'react'

interface State {
  error: Error | null
  info: string
}

/** Last line of defense: a render error anywhere below shows a recoverable
 *  crash panel instead of a white window. */
export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer] crash:', error, info.componentStack)
    this.setState({ info: info.componentStack ?? '' })
  }

  private copyDetails = async (): Promise<void> => {
    const { error, info } = this.state
    try {
      await navigator.clipboard.writeText(`${error?.stack ?? error?.message ?? 'unknown'}\n\nComponent stack:${info}`)
    } catch {
      /* clipboard unavailable */
    }
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <div className="crash__card">
          <h1>Something broke in the UI</h1>
          <p>
            The view crashed while rendering. Your cluster is untouched - this is purely a display error.
          </p>
          <pre className="conflict-pre">{error.message}</pre>
          <div className="crash__actions">
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              Reload app
            </button>
            <button className="btn btn--secondary" onClick={this.copyDetails}>
              Copy error details
            </button>
          </div>
        </div>
      </div>
    )
  }
}
