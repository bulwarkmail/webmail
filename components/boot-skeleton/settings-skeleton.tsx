import { ArrowLeft, ChevronRight, LogOut, MoreVertical, Search, Settings } from "@/components/icons";
import { SETTINGS_NAV_GROUPS, SETTINGS_TAB_ICONS } from "@/components/settings/settings-tab-icons";
import type { SettingsSearchTab } from "@/lib/settings-search";
import { cn } from "@/lib/cn";
import { Bar, Block, Circle, repeat, textWidth } from "./kit";
import { AppShellSkeleton, type RailLabels } from "./shell";

export interface SettingsSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
}

/**
 * Rows the nav may leave out, hidden when the last session's nav didn't have
 * them (`data-boot-settings-tabs`, app/boot-skeleton.css). Calendar and files
 * also follow the rail's hints. Recovery is an Enterprise feature, so it is
 * only drawn when the hints say it was there.
 */
const OPTIONAL: Partial<Record<SettingsSearchTab, string>> = {
  security: "boot-no-settings-security:hidden",
  sharing: "boot-no-settings-sharing:hidden",
  filters: "boot-no-settings-filters:hidden",
  vacation: "boot-no-settings-vacation:hidden",
  recovery: "hidden boot-settings-recovery:flex",
  calendar: "boot-no-calendar:hidden boot-no-settings-calendar:hidden",
  contacts: "boot-no-settings-contacts:hidden",
  files: "boot-no-files:hidden boot-no-settings-files:hidden",
  addons: "boot-no-settings-addons:hidden",
  // Not in the static Lite build.
  offline: "boot-no-settings-offline:hidden",
};

/** A line of text as tall as its line box, so rows keep the real height. */
function Line({ className, bar, w }: { className?: string; bar: string; w: string }) {
  return (
    <span className={cn("flex items-center h-[1lh]", className)}>
      <Bar className={bar} w={w} />
    </span>
  );
}

/** The search field (ToolbarSearch): an h-8 input with the magnifier at its start. */
function SearchField() {
  return (
    <span className="relative block">
      <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
      <span className="block h-8 w-full rounded-md border border-input bg-background" />
    </span>
  );
}

/** The Advanced switch row at the foot of the nav (AdvancedSettingsSwitch). */
function AdvancedRow() {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
      <Line bar="h-3" w="7rem" />
      <Block className="h-6 w-11 rounded-full" />
    </div>
  );
}

/** The desktop nav (settings-app.tsx, "Desktop layout"). */
function SettingsNav({ embedded }: { embedded: boolean }) {
  let row = 0;
  return (
    <div
      aria-hidden="true"
      className="border-e border-border bg-secondary flex flex-col shrink-0 max-lg:max-w-52"
      style={{ width: "var(--boot-settings-nav-w, 256px)" }}
    >
      {embedded ? null : (
        // Back to mail; the Pro interface has none.
        <div className="border-b border-border boot-pro:hidden">
          <div className="flex items-center h-14 px-2">
            <span className="flex items-center w-full h-9 px-3 text-sm">
              <ArrowLeft className="w-4 h-4 me-2" />
              <Bar className="h-3" w="6rem" />
            </span>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden py-2">
        <div className="px-3 pt-1 pb-1">
          <SearchField />
        </div>
        <div className="px-3 space-y-0.5">
          {SETTINGS_NAV_GROUPS.map(({ group, tabs }, groupIndex) => (
            <div key={group}>
              {groupIndex > 0 ? <div className="mx-1 my-2 border-t border-border" /> : null}
              {group === "mail" || group === "apps" ? (
                <div className="px-3 pt-2.5 pb-1">
                  {/* An inline span in the real nav: the line box is the parent's. */}
                  <Line bar="h-2" w="3rem" />
                </div>
              ) : null}
              {tabs.map((tab) => {
                const Icon = SETTINGS_TAB_ICONS[tab];
                const i = row++;
                return (
                  <div
                    key={tab}
                    data-sk-settings-tab={tab}
                    className={cn(
                      "flex w-full py-2 pe-3 ps-3 rounded-md text-sm items-center gap-2.5 text-muted-foreground",
                      // The open page, from data-boot-settings-tab (app/boot-skeleton.css).
                      "boot-settings-active:bg-accent boot-settings-active:text-accent-foreground",
                      OPTIONAL[tab],
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <Line className="flex-1 min-w-0" bar="h-3" w={textWidth(i, 35, 35)} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-border px-1 py-1">
        <AdvancedRow />
      </div>
    </div>
  );
}

/** A settings page: the section jump row, then sections of rows (settings-section.tsx). */
function SettingsPage({ sections }: { sections: number }) {
  return (
    <>
      {/* The section jump row; none on a page with one section, two lines on
          Accessibility (app/boot-skeleton.css). */}
      <div className="flex flex-wrap gap-1.5 mb-6 boot-settings-one-section:hidden">
        {repeat(4, (i) => (
          <Block className="h-8" w={`${4.5 + ((i * 3) % 4)}rem`} />
        ))}
        <Block className="h-8 basis-full hidden boot-settings-two-rows:block" />
      </div>
      <div className="space-y-8">
        {repeat(sections, (s) => (
          <div className="space-y-4">
            <div>
              <Line className="text-lg" bar="h-4" w={textWidth(s, 20, 20)} />
              <Line className="text-sm mt-1" bar="h-3" w={textWidth(s + 3, 45, 35)} />
            </div>
            <div className="space-y-4">
              {repeat(3, (r) => (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4 py-3 border-b border-border last:border-0">
                  <div className="flex-1 min-w-0 sm:pe-4">
                    <Line className="text-sm" bar="h-3" w={textWidth(s * 3 + r, 25, 25)} />
                    <Line className="text-xs mt-1" bar="h-2.5" w={textWidth(s * 3 + r + 5, 45, 40)} />
                  </div>
                  <Block className={r % 2 ? "h-6 w-11 rounded-full" : "h-8 w-28"} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** A phone header row: back arrow, title, then the ⋮ menu and the avatar (PhoneHeaderActions). */
function PhoneHeader({ list }: { list: boolean }) {
  return (
    <div data-window-row-right="" className="flex items-center gap-2 px-4 h-14 border-b border-border bg-background shrink-0">
      <span className="grid place-items-center h-11 w-11 shrink-0">
        <ArrowLeft className="w-5 h-5" />
      </span>
      {list ? (
        <span className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-muted-foreground" />
          <Line className="text-lg" bar="h-4" w="5rem" />
        </span>
      ) : (
        <Line className="text-lg" bar="h-4" w="7rem" />
      )}
      <span className="flex items-center gap-1 flex-shrink-0 ms-auto">
        <span className="grid place-items-center h-11 w-11">
          <MoreVertical className="w-5 h-5" />
        </span>
        <span className="flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11">
          <Circle className="w-8 h-8" />
        </span>
      </span>
    </div>
  );
}

/** The phone and tablet list of pages (settings-app.tsx, "Mobile layout"). */
function PhoneList() {
  let row = 0;
  return (
    <div aria-hidden="true" className="flex flex-col flex-1 min-h-0 boot-open:hidden">
      <PhoneHeader list />
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="px-4 pt-3 pb-1">
          <SearchField />
        </div>
        <div className="py-2">
          {SETTINGS_NAV_GROUPS.map(({ group, tabs }, groupIndex) => (
            <div key={group}>
              {groupIndex > 0 ? <div className="mx-5 my-2 border-t border-border" /> : null}
              {group === "mail" || group === "apps" ? (
                <div className="px-5 pt-3 pb-1.5">
                  {/* An inline span in the real nav: the line box is the parent's. */}
                  <Line bar="h-2" w="3rem" />
                </div>
              ) : null}
              {tabs.map((tab) => {
                const Icon = SETTINGS_TAB_ICONS[tab];
                const i = row++;
                return (
                  <div
                    key={tab}
                    className={cn(
                      "flex w-full items-center justify-between py-3.5 pe-5 ps-5 text-sm text-muted-foreground",
                      OPTIONAL[tab],
                    )}
                  >
                    <span className="flex items-center gap-3 flex-1 min-w-0">
                      <Icon className="w-4 h-4 shrink-0" />
                      <Line className="flex-1" bar="h-3" w={textWidth(i, 30, 30)} />
                    </span>
                    <ChevronRight className="w-4 h-4 shrink-0" />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="border-t border-border px-2 py-2">
          <AdvancedRow />
        </div>
        <div className="border-t border-border px-5 py-3">
          <span className="w-full flex items-center gap-3 py-2.5 text-sm text-destructive px-2">
            <LogOut className="w-4 h-4" />
            <Line bar="h-3" w="4rem" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** One settings page on the phone or tablet, when the URL names one. */
function PhonePage() {
  return (
    <div aria-hidden="true" className="hidden boot-open:flex flex-col flex-1 min-h-0">
      <PhoneHeader list={false} />
      <div className="flex-1 min-h-0 overflow-hidden p-4">
        <SettingsPage sections={2} />
      </div>
    </div>
  );
}

/**
 * The settings page's own content: everything in the row next to the rail.
 * `embedded` is the variant drawn inside a Pro pane (useIsEmbedded()), which
 * has no rail, no Mountain View shell and fills its pane (h-full); it has no
 * back-to-mail box either, and the Pro shell is desktop only.
 */
export function SettingsSkeletonBody({ embedded = false }: { embedded?: boolean }) {
  return (
    <div
      className={cn("flex-1 min-w-0 min-h-0 flex", embedded ? "h-full" : "flex-col desk:flex-row")}
      data-embedded={embedded ? "" : undefined}
    >
      <div className={cn("flex-1 min-w-0 min-h-0", embedded ? "flex" : "hidden desk:flex")}>
        <SettingsNav embedded={embedded} />
        <div aria-hidden="true" className="flex-1 min-w-0 overflow-hidden">
          {embedded ? null : (
            <div data-window-only="" data-window-row-right="" className="items-center gap-2 h-14 box-content border-b border-border px-2 sm:px-4 lg:px-6 shrink-0">
              <Line className="text-sm" bar="h-3.5" w="6rem" />
            </div>
          )}
          <div className="max-w-3xl mx-auto px-6 py-6">
            <SettingsPage sections={3} />
          </div>
        </div>
      </div>
      {embedded ? null : (
        <div className="flex flex-col flex-1 min-h-0 desk:hidden">
          <PhoneList />
          <PhonePage />
        </div>
      )}
    </div>
  );
}

/** Skeleton of the settings page. */
export function SettingsSkeleton({ label, labels }: SettingsSkeletonProps) {
  return (
    <AppShellSkeleton
      surface="settings"
      label={label}
      labels={labels}
      active="settings"
      // Mountain View: the page sits on a card inset from the canvas.
      rowClassName="desk:mv:mb-4 desk:mv:mx-4 desk:mv:rounded-[var(--mv-card-radius)] desk:mv:bg-background"
    >
      <SettingsSkeletonBody />
    </AppShellSkeleton>
  );
}
