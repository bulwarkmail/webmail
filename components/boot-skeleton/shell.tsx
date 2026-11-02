/**
 * The app frame every signed-in page shares, as a skeleton: the page root, the
 * Mountain View top bar, the vertical rail and the phone bottom bar. Class
 * lists mirror the real ones (components/layout/navigation-rail.tsx,
 * components/layout/mv-top-bar.tsx and the roots of mail-app, calendar-app,
 * contacts-app, files-app, settings-app), so the frame doesn't move when the
 * page takes over.
 */
import type { ReactNode } from "react";
import {
  Accessibility,
  Bell,
  CalendarEvent,
  Folder,
  Grid3x3,
  Keyboard,
  Mail,
  Menu,
  Plus,
  Search,
  Settings,
  Shield,
  Users,
} from "@/components/icons";
import { cn } from "@/lib/cn";
import { Bar, Circle, SkeletonRegion, type SkeletonSurface } from "./kit";
import { LoginSkeleton } from "./login-skeleton";
import { ProFrameSkeleton } from "./pro-skeleton";
import { PRO_SURFACES, type BootSurface } from "@/lib/boot-skeleton/surfaces";

export type RailApp = "mail" | "calendar" | "contacts" | "files" | "settings";

/** A rail item drawn as current: an app, or the admin panel (NavigationRail adminActive). */
export type RailActive = RailApp | "admin";

/** Translated rail labels for the phone bottom bar; bars are drawn where one is missing. */
export type RailLabels = Partial<Record<RailApp | "admin", string>>;

const RAIL_BORDER = { borderRight: "1px solid rgba(128, 128, 128, 0.3)" } as const;
const DIVIDER = { borderColor: "rgba(128, 128, 128, 0.3)" } as const;

/** Hidden when the last session's rail didn't show the app (bulwark-boot-hints). */
const APP_HIDE: Record<"calendar" | "contacts" | "files", string> = {
  calendar: "boot-no-calendar:hidden",
  contacts: "boot-no-contacts:hidden",
  files: "boot-no-files:hidden",
};

const APPS = [
  { id: "mail", icon: Mail },
  { id: "calendar", icon: CalendarEvent },
  { id: "contacts", icon: Users },
  { id: "files", icon: Folder },
] as const;

/**
 * The 56px vertical rail (NavigationRail collapsed). `className` decides at
 * which widths it shows. `search` draws the global search button the Pro
 * shell's rail starts with. Items carry `data-sk-rail` so the Pro frame can
 * mark the focused tab's app from CSS.
 */
export function RailSkeleton({
  active,
  search = false,
  className,
}: {
  active?: RailActive;
  search?: boolean;
  className?: string;
}) {
  const item = (on: boolean) =>
    cn(
      "relative flex items-center justify-center w-10 h-10 rounded-md max-lg:min-h-[44px]",
      on ? "bg-primary/10 text-primary" : "text-muted-foreground",
    );
  const footerItem = "flex items-center justify-center w-10 h-10 rounded-md";
  return (
    <div aria-hidden="true" className={cn("w-14 bg-secondary flex-col flex-shrink-0", className)} style={RAIL_BORDER}>
      <div className="flex flex-col h-full items-center">
        <div className="flex flex-col flex-1 min-h-0 items-center gap-1 py-3 px-1">
          {search ? (
            <span className={item(false)}>
              <Search className="w-[18px] h-[18px] flex-shrink-0" />
            </span>
          ) : null}
          {APPS.map(({ id, icon: Icon }) => (
            <span key={id} data-sk-rail={id} className={cn(item(active === id), id !== "mail" && APP_HIDE[id])}>
              <Icon className={cn("w-[18px] h-[18px] flex-shrink-0", active === id && "text-primary")} />
            </span>
          ))}
          <span className={cn(item(false), "hidden boot-rail-add-app:flex")}>
            <Plus className="w-[18px] h-[18px] flex-shrink-0" />
          </span>
        </div>
        <div className="mt-auto flex flex-col items-center gap-2 pb-3 px-1 text-muted-foreground">
          <span className={cn(footerItem, active === "admin" ? "bg-primary/10 text-primary" : "hidden boot-rail-admin:flex")}>
            <Shield className="w-[18px] h-[18px]" />
          </span>
          <span className={footerItem}>
            <Bell className="w-[18px] h-[18px]" />
          </span>
          <span className={cn(footerItem, "hidden boot-rail-a11y:flex")}>
            <Accessibility className="w-[18px] h-[18px]" />
          </span>
          <span data-sk-rail="settings" className={cn(footerItem, active === "settings" && "bg-primary/10 text-primary")}>
            <Settings className="w-[18px] h-[18px]" />
          </span>
          <div className="w-8 border-t" style={DIVIDER} />
          <span className={footerItem}>
            <Keyboard className="w-[18px] h-[18px]" />
          </span>
          {/* The admin panel's rail has no mailbox: no quota, no account. */}
          {active === "admin" ? null : (
            <>
              <Circle className="hidden boot-rail-quota:block w-8 h-8" />
              <span className="flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11">
                <Circle className="w-8 h-8" />
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The phone/tablet bottom bar (NavigationRail horizontal). `className` decides
 * at which widths it shows.
 */
export function BottomBarSkeleton({
  active,
  labels,
  className,
}: {
  active?: RailActive;
  labels?: RailLabels;
  className?: string;
}) {
  // The admin panel's own bar has its entry before Settings.
  const items: { id: RailActive; icon: typeof Mail }[] = [
    ...APPS,
    ...(active === "admin" ? [{ id: "admin" as const, icon: Shield }] : []),
    { id: "settings", icon: Settings },
  ];
  return (
    <div
      aria-hidden="true"
      className={cn(
        "items-center bg-background border-t border-border shrink-0 overflow-hidden pb-[calc(env(safe-area-inset-bottom)/2)]",
        "mv:min-h-16 mv:border-t-0 mv:bg-secondary mv:shadow-[0_-1px_3px_rgb(0_0_0/0.08)]",
        className,
      )}
    >
      {items.map(({ id, icon: Icon }) => (
        <span
          key={id}
          className={cn(
            "flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px]",
            active === id ? "text-primary" : "text-muted-foreground",
            (id === "calendar" || id === "contacts" || id === "files") && APP_HIDE[id],
          )}
        >
          <span className={cn("relative", active === id && "mv:min-w-14 mv:rounded-full mv:bg-primary/15 mv:px-4 mv:py-[3px]")}>
            <Icon className="w-5 h-5" />
            {active === id ? (
              <span className="mv:hidden absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded-full bg-primary" />
            ) : null}
          </span>
          {labels?.[id] ? (
            <span className="text-[0.625rem] font-medium leading-tight truncate max-w-full">{labels[id]}</span>
          ) : (
            <Bar className="h-2 my-px" w="2rem" />
          )}
        </span>
      ))}
    </div>
  );
}

/** Mountain View's 64px top bar (components/layout/mv-top-bar.tsx), desktop only. */
export function MvTopBarSkeleton({
  search = true,
  menu = true,
  className,
}: {
  search?: boolean;
  /** The sidebar toggle before the brand (MvTopBar showMenuButton). */
  menu?: boolean;
  className?: string;
}) {
  const round = "grid place-items-center w-12 h-12 rounded-full text-muted-foreground";
  return (
    <div aria-hidden="true" className={cn("items-center h-16 gap-2 ps-1 pe-4 shrink-0 bg-[var(--mv-canvas)]", className)}>
      <div className={cn("flex items-center gap-1 shrink-0", !menu && "ps-3")}>
        {menu ? (
          <span className={round}>
            <Menu className="w-5 h-5" />
          </span>
        ) : null}
        <span className="flex items-center gap-2 pe-4 min-w-0">
          <Bar className="h-5" w="7rem" />
        </span>
      </div>
      {search ? (
        <div className="relative flex items-center flex-1 min-w-0 max-w-[720px]">
          <span className="block w-full h-[var(--mv-search-h,48px)] rounded-[var(--mv-search-radius,8px)] bg-[var(--mv-search-bg)]" />
        </div>
      ) : null}
      <div className="flex-1 min-w-0" />
      <div className="flex items-center gap-1 shrink-0">
        <span className={round}>
          <Bell className="w-5 h-5" />
        </span>
        <span className={round}>
          <Keyboard className="w-5 h-5" />
        </span>
        <span className={cn(round, "hidden boot-rail-admin:grid")}>
          <Shield className="w-5 h-5" />
        </span>
        <span className={round}>
          <Settings className="w-5 h-5" />
        </span>
        <span className={round}>
          <Grid3x3 className="w-5 h-5" />
        </span>
        {/* The account switcher (AccountSwitcher variant="header"). */}
        <span className="flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 ms-1">
          <Circle className="w-8 h-8" />
        </span>
      </div>
    </div>
  );
}

interface AppShellSkeletonProps {
  surface: SkeletonSurface;
  /** The page's own "Loading" string (common.loading). */
  label?: string;
  /** Rail item drawn as current. */
  active?: RailApp;
  /**
   * Below which width the vertical rail gives way to the bottom bar: mail and
   * settings switch at 64rem, calendar, contacts, files and plugin pages at 48rem.
   */
  railBelow: "md" | "lg";
  labels?: RailLabels;
  /** Whether the Mountain View top bar holds the search field (mail does). */
  mvSearch?: boolean;
  /** Whether the Mountain View top bar starts with the sidebar toggle (MvTopBar showMenuButton). */
  mvMenu?: boolean;
  /** Extra classes for the row under the top bar (Mountain View card margins etc.). */
  rowClassName?: string;
  children: ReactNode;
}

/**
 * Page root plus frame. `children` go in the row next to the rail: the page's
 * own sidebar, list and panes.
 *
 * When nothing is stored that could sign the visitor back in, the boot script
 * marks the page `data-boot-auth="out"` and the login card is drawn instead:
 * that is where the app is about to send them.
 *
 * When the Pro interface is about to take the page over (`data-boot-pro="on"`:
 * the setting is on and the screen is a desktop), the Pro frame is drawn
 * instead, so the hop to /pro moves nothing. The login card wins over it: a
 * signed-out visitor ends up on the login page either way.
 */
export function AppShellSkeleton({
  surface,
  label,
  active,
  railBelow,
  labels,
  mvSearch = false,
  mvMenu = true,
  rowClassName,
  children,
}: AppShellSkeletonProps) {
  return (
    <>
      <div className="hidden boot-out:block">
        <LoginSkeleton label={label} accessibilityButton />
      </div>
      {(PRO_SURFACES as readonly string[]).includes(surface) ? (
        <div className="hidden boot-pro-frame:block">
          <ProFrameSkeleton label={label} surface={surface as BootSurface} />
        </div>
      ) : null}
      <SkeletonRegion
        surface={surface}
        label={label}
        className="flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] h-dvh bg-background lg:mv:bg-[var(--mv-canvas)] boot-out:hidden boot-pro-frame:hidden"
      >
        <MvTopBarSkeleton search={mvSearch} menu={mvMenu} className="hidden lg:mv:flex" />
        <div className={cn("flex flex-1 min-h-0 overflow-hidden", rowClassName)}>
          <RailSkeleton
            active={active}
            className={railBelow === "lg" ? "hidden lg:flex lg:mv:hidden" : "hidden md:flex lg:mv:hidden"}
          />
          {children}
        </div>
        <BottomBarSkeleton
          active={active}
          labels={labels}
          className={railBelow === "lg" ? "flex lg:hidden" : "flex md:hidden"}
        />
      </SkeletonRegion>
    </>
  );
}
