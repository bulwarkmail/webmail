import { AppShellSkeleton, type RailLabels } from "./shell";

export interface SettingsSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/** Skeleton of the settings page. Stub: filled in per surface. */
export function SettingsSkeleton({ label, labels }: SettingsSkeletonProps) {
  return (
    <AppShellSkeleton surface="settings" label={label} labels={labels} railBelow="lg" active="settings">
      <div className="flex-1 min-w-0" />
    </AppShellSkeleton>
  );
}
