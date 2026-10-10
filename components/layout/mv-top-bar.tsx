"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookUser,
  Calendar,
  Filter,
  Grid3x3,
  HardDrive,
  Keyboard,
  Mail,
  Menu,
  Settings,
  Shield,
  iconForName,
} from "@/components/icons";
import type { AppIcon as AppIconType } from "@/components/icons";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useConfig } from "@/hooks/use-config";
import { usePolicyStore } from "@/stores/policy-store";
import { useResolvedSidebarApps } from "@/hooks/use-resolved-sidebar-apps";
import { useThemeStore } from "@/stores/theme-store";
import { useUIStore } from "@/stores/ui-store";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { getPathPrefix, withBasePath } from "@/lib/browser-navigation";
import { useStalwartAdmin } from "@/hooks/use-stalwart-admin";
import { useUpdateStore, selectHasUpdate } from "@/stores/update-store";
import { cn } from "@/lib/utils";
import { AccountSwitcher } from "@/components/layout/account-switcher";
import { SearchBox, type ContactSearchField } from "@/components/search/search-box";
import type { ContactSuggestion } from "@/lib/search-suggestions";

/** Mail search, which only the mail surface puts into the bar. */
interface MvTopBarSearch {
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: (query: string) => void;
  onClear: () => void;
  onSelectContact: (contact: ContactSuggestion, field: ContactSearchField) => void;
  /** Opens the advanced-filter panel that lives under the message list. */
  onToggleFilters: () => void;
  filtersOpen: boolean;
  activeFilterCount: number;
  disabled?: boolean;
  /**
   * Receives the node under the search field that the advanced-filter panel is
   * portalled into, so the panel drops from the field itself; without this
   * the panel would stay behind in the message-list column, two bars away from
   * the button that opens it.
   */
  onFilterAnchorChange?: (node: HTMLDivElement | null) => void;
}

interface MvTopBarProps {
  /**
   * The mail search field. Other surfaces leave it out and keep their own
   * search where it was; the bar then carries the brand, the app grid and the
   * account avatar only.
   */
  search?: MvTopBarSearch;
  /** The hamburger folds the mail navigation, so only mail shows it. */
  showMenuButton?: boolean;
  onShowShortcuts?: () => void;
  onManageApps?: () => void;
  onInlineApp?: (appId: string, url: string, name: string) => void;
  onCloseInlineApp?: () => void;
  activeAppId?: string | null;
  /** Opens the merged across-accounts inbox from the account popover. */
  onSelectAllInboxes?: () => void;
  allInboxesSelected?: boolean;
}

/**
 * Mountain View's global header: one 64px row that owns the hamburger, the
 * brand, the search field and the account cluster. It only renders on
 * desktop under `interfaceLayout === 'mountain-view'` (see
 * useMountainViewShell), on every surface, in place of the left rail; the
 * default layout keeps search inside the list column and navigation in the
 * left rail, and neither of those is touched here.
 */
export function MvTopBar({
  search,
  showMenuButton = true,
  onShowShortcuts,
  onManageApps,
  onInlineApp,
  onCloseInlineApp,
  activeAppId,
  onSelectAllInboxes,
  allInboxesSelected = false,
}: MvTopBarProps) {
  const t = useTranslations("sidebar");
  const tSearch = useTranslations("advanced_search");
  const pathname = usePathname();
  const { appName, appLogoLightUrl, appLogoDarkUrl } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);

  const client = useAuthStore((s) => s.client);
  const { supportsCalendar } = useCalendarStore();
  const calendarEnabled = usePolicyStore((s) => s.isFeatureEnabled("calendarEnabled"));
  const contactsEnabled = usePolicyStore((s) => s.isFeatureEnabled("contactsEnabled"));
  const filesEnabled = usePolicyStore((s) => s.isFeatureEnabled("filesEnabled"));
  // The same gate the navigation rail puts on its "add app" button.
  const sidebarAppsEnabled = usePolicyStore((s) => s.isFeatureEnabled("sidebarAppsEnabled"));
  const sidebarApps = useResolvedSidebarApps();
  const isStalwartAdmin = useStalwartAdmin();
  const hasUpdate = useUpdateStore(selectHasUpdate);
  // The navigation rail starts the update check, and this bar replaces it on
  // desktop; without this the admin shield's update dot never lights up.
  const startUpdatePolling = useUpdateStore((s) => s.startPolling);
  useEffect(() => { startUpdatePolling(); }, [startUpdatePolling]);
  const updateSeverity = useUpdateStore((s) => s.status?.severity);
  const updateImportant = updateSeverity === "security" || updateSeverity === "deprecated";

  const [appsOpen, setAppsOpen] = useState(false);
  const appsButtonRef = useRef<HTMLButtonElement>(null);
  const closeApps = useCallback(() => setAppsOpen(false), []);
  const { menuRef: appsMenuRef, onKeyDown: onAppsKeyDown } = useMenuNavigation<HTMLDivElement>({
    open: appsOpen,
    onClose: closeApps,
    triggerRef: appsButtonRef,
  });

  useEffect(() => {
    if (!appsOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        appsButtonRef.current?.contains(e.target as Node) ||
        appsMenuRef.current?.contains(e.target as Node)
      ) return;
      setAppsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [appsOpen, appsMenuRef]);

  const apps: Array<{ id: string; icon: AppIconType; label: string; href: string }> = [
    { id: "mail", icon: Mail, label: t("mail"), href: "/" },
    ...(supportsCalendar && calendarEnabled
      ? [{ id: "calendar", icon: Calendar, label: t("calendar"), href: "/calendar" }]
      : []),
    ...((client?.supportsContacts() ?? false) && contactsEnabled
      ? [{ id: "contacts", icon: BookUser, label: t("contacts"), href: "/contacts" }]
      : []),
    ...((client?.supportsFiles() ?? false) && filesEnabled
      ? [{ id: "files", icon: HardDrive, label: t("files"), href: "/files" }]
      : []),
    { id: "settings", icon: Settings, label: t("settings"), href: "/settings" },
  ];

  const isActive = (href: string) =>
    !activeAppId && (href === "/" ? pathname === "/" || pathname === "" : pathname.startsWith(href));

  const logoUrl = withBasePath(
    resolvedTheme === "dark" ? appLogoDarkUrl || appLogoLightUrl : appLogoLightUrl || appLogoDarkUrl
  );

  return (
    <header
      className="mv-topbar flex items-center h-16 gap-2 ps-1 pe-4 shrink-0 bg-background"
      data-mv-topbar=""
    >
      {/* Brand block: occupies the sidebar's own column width */}
      <div className={cn("flex items-center gap-1 shrink-0", !showMenuButton && "ps-3")}>
        {showMenuButton && (
          <button
            type="button"
            onClick={toggleSidebarCollapsed}
            className="grid place-items-center w-12 h-12 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label={t("mobile.toggle_menu")}
          >
            <Menu className="w-5 h-5" />
          </button>
        )}
        <Link href="/" className="flex items-center gap-2 pe-4 min-w-0" aria-label={appName}>
          {logoUrl ? <img src={logoUrl} alt="" className="w-8 h-8 object-contain" /> : null}
          <span className="text-[22px] leading-none text-foreground/80 truncate">{appName}</span>
        </Link>
      </div>

      {/* Search: left-anchored and capped, not centred */}
      {search && (
        <div className="mv-topbar-search relative flex items-center gap-1 flex-1 min-w-0 max-w-[720px]">
          <SearchBox
            value={search.query}
            onChange={search.onQueryChange}
            onSubmit={search.onSubmit}
            onClear={search.onClear}
            onSelectContact={search.onSelectContact}
            disabled={search.disabled}
          />
          <button
            type="button"
            onClick={search.onToggleFilters}
            disabled={search.disabled}
            // Inside the field's trailing end, next to the typed query.
            className={cn(
              "absolute end-1 top-1/2 -translate-y-1/2 z-10 grid place-items-center w-10 h-10 rounded-full transition-colors",
              search.disabled && "opacity-50 cursor-not-allowed",
              search.filtersOpen || search.activeFilterCount > 0
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
            title={tSearch("toggle_filters")}
            aria-label={tSearch("toggle_filters")}
          >
            <Filter className="w-5 h-5" />
            {!search.filtersOpen && search.activeFilterCount > 0 && (
              <span className="absolute top-1.5 end-1.5 grid place-items-center w-4 h-4 text-[10px] font-bold rounded-full bg-primary text-primary-foreground">
                {search.activeFilterCount}
              </span>
            )}
          </button>

          {/* Anchor for the advanced-filter panel: the search field's own box,
              filter button included, so the panel shares the field's edges. It
              only marks the spot; the panel itself is drawn at the end of <body>. */}
          <div
            ref={search.onFilterAnchorChange}
            aria-hidden
            data-mv-filter-anchor=""
            className="pointer-events-none absolute start-0 end-0 top-full h-0"
          />
        </div>
      )}

      {/* Spacer keeps the right cluster pinned while search stays left */}
      <div className="flex-1 min-w-0" />

      <div className="flex items-center gap-1 shrink-0">
        {onShowShortcuts && (
          <button
            type="button"
            onClick={onShowShortcuts}
            className="grid place-items-center w-12 h-12 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title={t("keyboard_shortcuts")}
            aria-label={t("keyboard_shortcuts")}
          >
            <Keyboard className="w-5 h-5" />
          </button>
        )}
        {/* Admin (Stalwart admins), as in the navigation rail this bar replaces.
            A hard navigation because /admin lives outside the [locale] tree. */}
        {isStalwartAdmin && (
          <a
            href={`${getPathPrefix()}/admin`}
            className="relative grid place-items-center w-12 h-12 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title={t("admin")}
            aria-label={t("admin")}
          >
            <Shield className="w-5 h-5" />
            {hasUpdate && (
              <span
                className={cn(
                  "absolute top-3 end-3 w-2 h-2 rounded-full ring-2 ring-background",
                  updateImportant ? "bg-red-500" : "bg-amber-500",
                )}
                aria-label={updateImportant ? "Important update available" : "Update available"}
              />
            )}
          </a>
        )}
        <Link
          href="/settings"
          className="grid place-items-center w-12 h-12 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title={t("settings")}
          aria-label={t("settings")}
        >
          <Settings className="w-5 h-5" />
        </Link>

        <div className="relative">
          <button
            ref={appsButtonRef}
            type="button"
            onClick={() => setAppsOpen((v) => !v)}
            className={cn(
              "grid place-items-center w-12 h-12 rounded-full transition-colors",
              appsOpen
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
            title={t("add_app")}
            aria-label={t("add_app")}
            aria-haspopup="menu"
            aria-expanded={appsOpen}
          >
            <Grid3x3 className="w-5 h-5" />
          </button>
          {appsOpen && (
            <div
              ref={appsMenuRef}
              onKeyDown={onAppsKeyDown}
              role="menu"
              aria-label={t("nav_label")}
              className="absolute end-0 top-full mt-1 z-50 w-72 max-h-[70vh] overflow-y-auto rounded-2xl border border-border bg-popover p-3 shadow-xl"
            >
              <div className="grid grid-cols-3 gap-1">
                {apps.map((app) => {
                  const Icon = app.icon;
                  return (
                    <Link
                      key={app.id}
                      href={app.href}
                      role="menuitem"
                      onClick={() => {
                        if (activeAppId) onCloseInlineApp?.();
                        setAppsOpen(false);
                      }}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-lg py-3 px-1 text-center transition-colors hover:bg-muted",
                        isActive(app.href) && "bg-muted"
                      )}
                    >
                      <Icon className="w-6 h-6 text-muted-foreground" />
                      <span className="text-xs truncate max-w-full">{app.label}</span>
                    </Link>
                  );
                })}
                {sidebarApps.map((app) => {
                  const AppIcon = iconForName(app.icon);
                  return (
                    <button
                      key={app.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAppsOpen(false);
                        if (activeAppId === app.id) {
                          onCloseInlineApp?.();
                        } else if (app.openMode === "tab") {
                          window.open(app.url, "_blank", "noopener,noreferrer");
                        } else {
                          onInlineApp?.(app.id, app.url, app.name);
                        }
                      }}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-lg py-3 px-1 text-center transition-colors hover:bg-muted",
                        activeAppId === app.id && "bg-muted"
                      )}
                    >
                      {AppIcon ? <AppIcon className="w-6 h-6 text-muted-foreground" /> : null}
                      <span className="text-xs truncate max-w-full">{app.name}</span>
                    </button>
                  );
                })}
              </div>
              {sidebarAppsEnabled && onManageApps && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAppsOpen(false);
                    onManageApps();
                  }}
                  className="mt-2 w-full rounded-lg py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  {t("add_app")}
                </button>
              )}
            </div>
          )}
        </div>

        <AccountSwitcher
          variant="header"
          className="ms-1"
          onSelectAllInboxes={onSelectAllInboxes}
          allInboxesSelected={allInboxesSelected}
        />
      </div>
    </header>
  );
}
