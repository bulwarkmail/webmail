import { AppShellSkeleton, type RailLabels } from "./shell";

export interface FilesSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/** Skeleton of the files page. Stub: filled in per surface. */
export function FilesSkeleton({ label, labels }: FilesSkeletonProps) {
  return (
    <AppShellSkeleton surface="files" label={label} labels={labels} railBelow="md" active="files">
      <div className="flex-1 min-w-0" />
    </AppShellSkeleton>
  );
}
