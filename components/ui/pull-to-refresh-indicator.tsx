"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * `pulling`    finger is dragging the indicator down, below the trigger threshold
 * `ready`      pulled past the threshold — releasing now starts a refresh
 * `refreshing` refresh in flight, indicator parked at the threshold and spinning
 * `cancelling` snapping back after an incomplete pull
 * `finishing`  snapping back after the refresh resolved
 */
export type PullToRefreshPhase = "idle" | "pulling" | "ready" | "refreshing" | "cancelling" | "finishing";

export interface PullToRefreshState {
  phase: PullToRefreshPhase;
  /** How far the indicator has travelled from the top edge, in CSS pixels. */
  distance: number;
}

export interface PullToRefreshStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PullToRefreshState;
  set: (next: PullToRefreshState) => void;
}

const IDLE_STATE: PullToRefreshState = { phase: "idle", distance: 0 };

/**
 * A minimal external store for the pull state.
 *
 * The gesture updates on every touchmove, so this deliberately lives outside
 * React state: the hook that drives it is called from large app shells
 * (mail/calendar/contacts/files) and re-rendering those at touch frequency
 * would drop frames. Only the indicator subscribes.
 */
export function createPullToRefreshStore(): PullToRefreshStore {
  let state = IDLE_STATE;
  const listeners = new Set<() => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    set(next) {
      if (next.phase === state.phase && next.distance === state.distance) return;
      state = next.phase === "idle" ? IDLE_STATE : next;
      listeners.forEach((listener) => listener());
    },
  };
}

export interface PullToRefreshLabels {
  pull: string;
  release: string;
  refreshing: string;
}

interface PullToRefreshIndicatorProps {
  store: PullToRefreshStore;
  /** Pull distance at which releasing triggers a refresh. */
  threshold: number;
  labels: PullToRefreshLabels;
}

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function PullToRefreshIndicator({ store, threshold, labels }: PullToRefreshIndicatorProps) {
  const { phase, distance } = useSyncExternalStore(store.subscribe, store.getSnapshot, () => IDLE_STATE);

  // The indicator is portalled into document.body, which does not exist during
  // the server render or the hydration pass.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || phase === "idle") return null;

  const progress = threshold > 0 ? Math.min(1, distance / threshold) : 0;
  const settling = phase === "cancelling" || phase === "finishing";
  const spinning = phase === "refreshing";
  const label = phase === "pulling" || phase === "cancelling"
    ? labels.pull
    : phase === "ready"
      ? labels.release
      : labels.refreshing;

  return createPortal(
    <div
      data-testid="pull-to-refresh-indicator"
      data-phase={phase}
      role="status"
      aria-live="polite"
      aria-hidden={settling || undefined}
      className={cn(
        "pointer-events-none fixed left-1/2 z-[70] flex items-center gap-2 rounded-full",
        "border border-border bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur-sm",
        // The pull follows the finger, so only the snap-back and the park at
        // the threshold are animated.
        settling || spinning ? "transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none" : "",
      )}
      style={{
        top: "env(safe-area-inset-top, 0px)",
        // At distance 0 the pill sits exactly above the top edge, so it slides
        // into view as the pull grows.
        transform: `translate3d(-50%, calc(${distance}px - 100%), 0)`,
        opacity: settling ? 0 : phase === "pulling" ? 0.4 + 0.6 * progress : 1,
      }}
    >
      {spinning ? (
        <Loader2 className="h-5 w-5 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <svg className="h-5 w-5 -rotate-90" viewBox="0 0 24 24" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2.5"
            className="stroke-muted"
          />
          <circle
            cx="12"
            cy="12"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="stroke-primary"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
          />
        </svg>
      )}
      <span className="whitespace-nowrap text-xs font-medium text-foreground">{label}</span>
    </div>,
    document.body,
  );
}
