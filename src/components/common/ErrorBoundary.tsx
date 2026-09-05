import { Component, type ErrorInfo, type ReactNode } from "react";

import { GlassButton } from "@/components/glass/button";
import { EmptyState } from "@/components/common/EmptyState";
import { WarningCircle } from "@phosphor-icons/react";
import { createLogger, describeError } from "@/lib/log";

const log = createLogger("error-boundary");

interface ErrorBoundaryProps {
  /** Where the boundary sits, shown in the fallback so the report is actionable. */
  scope: string;
  children: ReactNode;
  /** Drops the surrounding glass chrome when the boundary already sits in one. */
  bare?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React has no hook equivalent for error boundaries, so this is the one class
 * component in the codebase: `getDerivedStateFromError` + `componentDidCatch`
 * only, no legacy lifecycle.
 *
 * It is a containment wall, not error handling. Callers still handle expected
 * failures (IPC rejections, query errors) where they happen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error("render failed", {
      scope: this.props.scope,
      name: error.name,
      message: error.message,
      componentStack: info.componentStack ?? null,
    });
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { name, message } = describeError(error);
    const fallback = (
      <EmptyState
        icon={<WarningCircle size={26} weight="duotone" />}
        title="这个界面出错了"
        description={`${this.props.scope}渲染时抛出异常，其余界面仍然可用。${name}: ${message}`}
        action={
          <GlassButton variant="ghost" size="md" onClick={this.reset}>
            重试
          </GlassButton>
        }
      />
    );

    if (this.props.bare) return fallback;
    return <div className="h-full p-8">{fallback}</div>;
  }
}
