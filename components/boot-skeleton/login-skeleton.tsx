import { SkeletonRegion } from "./kit";

export interface LoginSkeletonProps {
  /** common.loading */
  label?: string;
  className?: string;
}

/** Skeleton of the login page. Stub: filled in per surface. */
export function LoginSkeleton({ label, className }: LoginSkeletonProps) {
  return <SkeletonRegion surface="login" label={label} className={className ?? "min-h-dvh bg-background"} />;
}
