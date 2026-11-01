import { AppShellSkeleton, type RailLabels } from "./shell";

export interface PluginPageSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/** Skeleton of the apps page. Stub: filled in per surface. */
export function PluginPageSkeleton({ label, labels }: PluginPageSkeletonProps) {
  return (
    <AppShellSkeleton surface="apps" label={label} labels={labels} railBelow="md">
      <div className="flex-1 min-w-0" />
    </AppShellSkeleton>
  );
}
