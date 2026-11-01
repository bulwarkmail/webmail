import { AppShellSkeleton, type RailLabels } from "./shell";

export interface ContactsSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/** Skeleton of the contacts page. Stub: filled in per surface. */
export function ContactsSkeleton({ label, labels }: ContactsSkeletonProps) {
  return (
    <AppShellSkeleton surface="contacts" label={label} labels={labels} railBelow="md" active="contacts">
      <div className="flex-1 min-w-0" />
    </AppShellSkeleton>
  );
}
