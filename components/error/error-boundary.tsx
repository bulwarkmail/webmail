"use client";

import React, { Component, ReactNode } from "react";
import { useTranslations } from "next-intl";
import { debug } from "@/lib/debug";
import { captureException } from "@/lib/error-reporting/client";

export interface FallbackProps {
  error: Error;
  resetError: () => void;
  t: (key: string) => string;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: (props: FallbackProps) => ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Core error boundary class component (React requirement).
 * Receives translation function as prop from the functional wrapper.
 */
class ErrorBoundaryCore extends Component<
  ErrorBoundaryProps & { t: (key: string) => string },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Always log errors
    debug.error("[ErrorBoundary]", error.message, {
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });

    // Off unless error reporting is configured (lib/error-reporting/client.ts).
    // The component stack stays here: it names components, nothing else.
    captureException(error, "boundary", false);

    // Call optional error handler
    this.props.onError?.(error, errorInfo);
  }

  resetError = (): void => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      return this.props.fallback({
        error: this.state.error,
        resetError: this.resetError,
        t: this.props.t,
      });
    }
    return this.props.children;
  }
}

/**
 * Functional wrapper that injects translations into the error boundary.
 * Use this component to wrap any part of your UI that might throw errors.
 *
 * @example
 * <ErrorBoundary fallback={SidebarErrorFallback}>
 *   <Sidebar />
 * </ErrorBoundary>
 */
export function ErrorBoundary({
  children,
  fallback,
  onError,
  onReset,
}: ErrorBoundaryProps) {
  const t = useTranslations("errors");

  return (
    <ErrorBoundaryCore
      fallback={fallback}
      onError={onError}
      onReset={onReset}
      t={t}
    >
      {children}
    </ErrorBoundaryCore>
  );
}
