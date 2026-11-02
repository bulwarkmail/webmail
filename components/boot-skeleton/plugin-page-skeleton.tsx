import { cn } from "@/lib/cn";
import { Bar } from "./kit";
import { MV_CARD_ROW } from "./contacts-skeleton";
import { AppShellSkeleton, type RailLabels } from "./shell";
import { PhoneActionsSkeleton } from "./toolbar-skeleton";

export interface PluginPageSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/**
 * A plugin page's own content (components/plugins/plugin-page-app.tsx).
 * Nothing about the page is known before its plugin starts, not even its
 * title, so this is the frame's column: the phone header (PhoneAppHeader,
 * below 48rem) and an empty content area, which is also what the page shows
 * while the plugins start. `embedded` is the Pro pane variant: no header.
 */
export function PluginPageSkeletonBody({ embedded = false }: { embedded?: boolean }) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col flex-1 min-w-0", embedded && "h-full")} data-embedded={embedded ? "" : undefined}>
      {embedded ? null : (
        <div className="flex md:hidden items-center gap-2 h-14 shrink-0 border-b border-border bg-background px-4">
          <span className="flex items-center h-7 min-w-0">
            <Bar className="h-4" w="7rem" />
          </span>
          <PhoneActionsSkeleton className="flex" />
        </div>
      )}
      <div className="flex flex-col flex-1 min-h-0" />
    </div>
  );
}

/** Skeleton of a plugin page (/apps/<plugin>/<page>). */
export function PluginPageSkeleton({ label, labels }: PluginPageSkeletonProps) {
  return (
    <AppShellSkeleton surface="apps" label={label} labels={labels} railBelow="md" mvMenu={false} rowClassName={MV_CARD_ROW}>
      <PluginPageSkeletonBody />
    </AppShellSkeleton>
  );
}
