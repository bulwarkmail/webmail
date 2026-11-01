import { AppShellSkeleton, type RailLabels } from "./shell";

export interface MailSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/** Skeleton of the mail page. Stub: filled in per surface. */
export function MailSkeleton({ label, labels }: MailSkeletonProps) {
  return (
    <AppShellSkeleton surface="mail" label={label} labels={labels} railBelow="lg" active="mail" mvSearch>
      <div className="flex-1 min-w-0" />
    </AppShellSkeleton>
  );
}
