"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { debug } from "@/lib/debug";

interface Props {
  /** Named in the log, so it says which host stopped. */
  name: string;
  children: ReactNode;
}

/**
 * Around a background host: one that throws (while drawing or in an effect)
 * stops by itself and shows nothing, instead of taking the page down with it.
 * Only the log hears of it. Nothing comes back until the page loads again.
 */
export class HostBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    debug.error(`[${this.props.name}] stopped:`, error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
