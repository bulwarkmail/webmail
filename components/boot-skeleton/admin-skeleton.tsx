import { SkeletonRegion } from "./kit";

export interface AdminSkeletonProps {
  /** common.loading */
  label?: string;
  className?: string;
}

/** Skeleton of the admin page. Stub: filled in per surface. */
export function AdminSkeleton({ label, className }: AdminSkeletonProps) {
  return <SkeletonRegion surface="admin" label={label} className={className ?? "min-h-dvh bg-background"} />;
}
