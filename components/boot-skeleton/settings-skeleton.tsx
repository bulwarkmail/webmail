import { AppShellSkeleton, type RailLabels } from "./shell";

export interface SettingsSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/**
 * The settings page's own content: everything in the row next to the rail.
 * `embedded` is the variant drawn inside a Pro pane (useIsEmbedded()), which
 * has no rail, no Mountain View shell and fills its pane (h-full).
 */
export function SettingsSkeletonBody({ embedded = false }: { embedded?: boolean }) {
  return <div className="flex-1 min-w-0" data-embedded={embedded ? "" : undefined} />;
}

/** Skeleton of the settings page. Stub: filled in per surface. */
export function SettingsSkeleton({ label, labels }: SettingsSkeletonProps) {
  return (
    <AppShellSkeleton surface="settings" label={label} labels={labels} railBelow="lg" active="settings">
      <SettingsSkeletonBody />
    </AppShellSkeleton>
  );
}
