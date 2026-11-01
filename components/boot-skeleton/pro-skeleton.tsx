import { SkeletonRegion } from "./kit";

export interface ProSkeletonProps {
  /** common.loading */
  label?: string;
  className?: string;
}

/** Skeleton of the pro page. Stub: filled in per surface. */
export function ProSkeleton({ label, className }: ProSkeletonProps) {
  return <SkeletonRegion surface="pro" label={label} className={className ?? "min-h-dvh bg-background"} />;
}
