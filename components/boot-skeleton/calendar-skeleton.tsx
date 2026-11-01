import { AppShellSkeleton, type RailLabels } from "./shell";

export interface CalendarSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/** Skeleton of the calendar page. Stub: filled in per surface. */
export function CalendarSkeleton({ label, labels }: CalendarSkeletonProps) {
  return (
    <AppShellSkeleton surface="calendar" label={label} labels={labels} railBelow="md" active="calendar">
      <div className="flex-1 min-w-0" />
    </AppShellSkeleton>
  );
}
