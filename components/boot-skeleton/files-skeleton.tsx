import { AppShellSkeleton, type RailLabels } from "./shell";

export interface FilesSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/**
 * The files page's own content: everything in the row next to the rail.
 * `embedded` is the variant drawn inside a Pro pane (useIsEmbedded()), which
 * has no rail, no Mountain View shell and fills its pane (h-full).
 */
export function FilesSkeletonBody({ embedded = false }: { embedded?: boolean }) {
  return <div className="flex-1 min-w-0" data-embedded={embedded ? "" : undefined} />;
}

/** Skeleton of the files page. Stub: filled in per surface. */
export function FilesSkeleton({ label, labels }: FilesSkeletonProps) {
  return (
    <AppShellSkeleton surface="files" label={label} labels={labels} railBelow="md" active="files">
      <FilesSkeletonBody />
    </AppShellSkeleton>
  );
}
