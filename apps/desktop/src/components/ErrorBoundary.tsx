import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, EmptyState, WarningIcon } from '@animated-walls/design-system';
import { reportRendererError } from '../stores/appStores';

/** Keeps one failing page from blanking the whole window. Navigation still works. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    reportRendererError(error.message, `${error.stack ?? ''}\n${info.componentStack ?? ''}`);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<WarningIcon size={22} />}
          title="This page ran into a problem"
          action={<Button onClick={() => this.setState({ failed: false })}>Try again</Button>}
        >
          Your wallpapers and settings are safe. The details were saved to the log.
        </EmptyState>
      </div>
    );
  }
}
