import { AppShellSkeleton, type RailLabels } from "./shell";

export interface PluginPageSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/**
 * The apps page's own content: everything in the row next to the rail.
 * `embedded` is the variant drawn inside a Pro pane (useIsEmbedded()), which
 * has no rail, no Mountain View shell and fills its pane (h-full).
 */
export function PluginPageSkeletonBody({ embedded = false }: { embedded?: boolean }) {
  return <div className="flex-1 min-w-0" data-embedded={embedded ? "" : undefined} />;
}

/** Skeleton of the apps page. Stub: filled in per surface. */
export function PluginPageSkeleton({ label, labels }: PluginPageSkeletonProps) {
  return (
    <AppShellSkeleton surface="apps" label={label} labels={labels} railBelow="md">
      <PluginPageSkeletonBody />
    </AppShellSkeleton>
  );
}
