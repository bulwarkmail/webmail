/**
 * The Pro shell as a skeleton (app/(main)/[locale]/pro/page.tsx): the rail,
 * then one or two panes, each a tab strip (components/pro/pro-tab-bar.tsx)
 * over the active tab's page drawn embedded.
 *
 * The server can't know the stored tabs, so it draws every variant and CSS
 * picks one from what the boot script read out of `pro-tabs`
 * (data-boot-pro-*, see the "pro" section of app/boot-skeleton.css): how many
 * tabs each pane has, which is active, which pane has focus, whether the
 * split pane shows and on which side, and which page each pane shows.
 */
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import type { BootSurface } from "@/lib/boot-skeleton/surfaces";
import { Bar, Block, SkeletonRegion, repeat, textWidth } from "./kit";
import { SkeletonBody } from "./bodies";
import { LoginSkeleton } from "./login-skeleton";
import { RailSkeleton } from "./shell";

export interface ProSkeletonProps {
  /** common.loading */
  label?: string;
}

const LINE = "1px solid rgba(128, 128, 128, 0.3)";
const STRIP_BORDER: CSSProperties = { borderBottom: LINE };
const DIVIDER: CSSProperties = { borderInlineStart: LINE };
/** Most tabs a strip draws; the boot script caps its count to match. */
const MAX_TABS = 8;
const BODIES: BootSurface[] = ["mail", "calendar", "contacts", "files", "settings"];

/** ProTabBar: up to eight tabs, shown by CSS from the stored count. */
function TabStripSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="relative flex items-stretch h-9 bg-secondary px-1 overflow-hidden flex-shrink-0"
      style={STRIP_BORDER}
    >
      {repeat(MAX_TABS, (i) => (
        <span
          data-sk-pro-tab=""
          className={cn(
            "relative flex items-center gap-1.5 px-3 h-9 text-sm",
            "min-w-0 flex-1 basis-0 max-w-[200px] [min-width:80px]",
            "border-e border-border first:border-s",
          )}
        >
          <Block className="w-4 h-4 flex-shrink-0 rounded-sm" />
          <span className="flex-1 min-w-0">
            <Bar className="h-3 max-w-full" w={textWidth(i, 50, 30)} />
          </span>
          {/* The active tab's bottom edge hides the strip's border; the
              focused pane's active tab gets the accent top edge. */}
          <span className="absolute inset-x-0 -bottom-px h-px" style={{ backgroundColor: "inherit" }} />
          <span
            className="absolute inset-x-0 top-0 h-0.5"
            style={{ backgroundColor: "var(--sk-pro-tab-accent, transparent)" }}
          />
        </span>
      ))}
      <span className="flex-1 min-w-[8px]" />
    </div>
  );
}

/** One pane: its tab strip over the active tab's page. */
function PaneSkeleton({ pane, bodies, className }: { pane: "main" | "split"; bodies: BootSurface[]; className?: string }) {
  return (
    <div data-sk-pro-pane={pane} className={cn("flex flex-1 flex-col overflow-hidden min-w-0 min-h-0", className)}>
      <TabStripSkeleton />
      <div className="@container relative flex flex-1 flex-col overflow-hidden min-w-0 min-h-0">
        {bodies.map((surface) => (
          <div key={surface} data-sk-pro-body={surface} className="absolute inset-0 overflow-hidden">
            <div className="flex h-full min-h-0 overflow-hidden">
              <SkeletonBody surface={surface} embedded />
            </div>
          </div>
        ))}
        {/* A message, folder, search or compose tab: no page skeleton of its own. */}
        <div data-sk-pro-body="other" className="absolute inset-0 overflow-hidden bg-background" />
      </div>
    </div>
  );
}

/**
 * The Pro frame alone. AppShellSkeleton draws it in place of a standard
 * page's frame when Pro is about to take that page over; `data-pro-shell`
 * keeps a skeleton inside the real Pro shell from doing that again.
 */
export function ProFrameSkeleton({
  label,
  className,
  surface,
}: ProSkeletonProps & {
  className?: string;
  /**
   * Set when this frame stands in for a standard page Pro is about to take
   * over. Its panes are then drawn empty (tab strips only): the frame doesn't
   * move on the hop to /pro, and the page's body, which would otherwise be in
   * every standard page's HTML a second and third time for the few who use
   * Pro, fills in once /pro has loaded. /pro's own HTML draws the bodies.
   */
  surface?: BootSurface;
}) {
  const bodies = surface ? [] : BODIES;
  return (
    <SkeletonRegion
      surface="pro"
      label={label}
      className={cn("flex flex-col h-dvh bg-background overflow-hidden pt-[env(safe-area-inset-top)]", className)}
    >
      <div data-pro-shell="" className="flex flex-1 overflow-hidden">
        <RailSkeleton search className="flex" />
        <div className="relative flex flex-row flex-1 overflow-hidden min-w-0">
          <PaneSkeleton pane="main" bodies={bodies} />
          <div
            aria-hidden="true"
            className="hidden boot-pro-split:block boot-pro-split-left:-order-1 flex-shrink-0 w-px"
            style={DIVIDER}
          />
          <PaneSkeleton pane="split" bodies={bodies} className="hidden boot-pro-split:flex boot-pro-split-left:order-first" />
        </div>
      </div>
    </SkeletonRegion>
  );
}

/**
 * Skeleton of the Pro page, for its gate and the server HTML of /pro. A
 * visitor with nothing stored that could sign them back in gets the login
 * card's shape, as on every signed-in page.
 */
export function ProSkeleton({ label }: ProSkeletonProps) {
  return (
    <>
      <div className="hidden boot-out:block">
        <LoginSkeleton label={label} />
      </div>
      <ProFrameSkeleton label={label} className="boot-out:hidden" />
    </>
  );
}
