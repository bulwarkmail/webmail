import { SkeletonRegion } from "./kit";

export interface SetupSkeletonProps {
  /** common.loading */
  label?: string;
  className?: string;
}

/** Skeleton of the setup page. Stub: filled in per surface. */
export function SetupSkeleton({ label, className }: SetupSkeletonProps) {
  return <SkeletonRegion surface="setup" label={label} className={className ?? "min-h-dvh bg-background"} />;
}
