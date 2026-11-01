import { AppShellSkeleton, type RailLabels } from "./shell";

export interface CalendarSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/**
 * The calendar page's own content: everything in the row next to the rail.
 * `embedded` is the variant drawn inside a Pro pane (useIsEmbedded()), which
 * has no rail, no Mountain View shell and fills its pane (h-full).
 */
export function CalendarSkeletonBody({ embedded = false }: { embedded?: boolean }) {
  return <div className="flex-1 min-w-0" data-embedded={embedded ? "" : undefined} />;
}

/** Skeleton of the calendar page. Stub: filled in per surface. */
export function CalendarSkeleton({ label, labels }: CalendarSkeletonProps) {
  return (
    <AppShellSkeleton surface="calendar" label={label} labels={labels} railBelow="md" active="calendar">
      <CalendarSkeletonBody />
    </AppShellSkeleton>
  );
}
