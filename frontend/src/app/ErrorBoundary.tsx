// A crash must never look like an empty page.
//
// A React render error unmounts the whole tree, and with nothing above it the result
// is a white screen: no message, no reload button, nothing to report. A clinic sees a
// broken product and cannot tell anyone what broke. This turns that into a stated
// failure with a way out, and prints the error where a screenshot will capture it.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack out of the UI but in the console, so a developer
    // opening the tab sees exactly where it came from.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="w-full max-w-lg space-y-4 rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <h1 className="text-lg font-semibold text-destructive">This page could not be displayed</h1>
          <p className="text-sm text-muted-foreground">
            Something went wrong while drawing this screen. Your data is safe — nothing was saved or
            changed by this error. Reloading usually fixes it.
          </p>
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs">{error.message}</pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground"
            >
              Reload the page
            </button>
            <button
              type="button"
              onClick={() => { window.location.href = "/"; }}
              className="rounded-md border px-4 py-2 text-sm font-medium"
            >
              Go to the dashboard
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            If it keeps happening, send this message to support — the text above says what failed.
          </p>
        </div>
      </div>
    );
  }
}
