"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Mail, Calendar, BookUser, HardDrive, Settings, Keyboard, Plus, Shield, LogOut, Check } from "lucide-react";
import { AccountSwitcher } from "./account-switcher";
import { icons as lucideIcons, type LucideIcon } from "lucide-react";
import { useConfig } from "@/hooks/use-config";
import { useThemeStore } from "@/stores/theme-store";
import { usePathname, Link } from "@/i18n/navigation";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useCalendarStore } from "@/stores/calendar-store";
import { useEmailStore } from "@/stores/email-store";
import { useWebDAVStore } from "@/stores/webdav-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useAuthStore } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { getActiveAccountSlotHeaders } from "@/lib/auth/active-account-slot";
import { getInitials } from "@/lib/account-utils";
import { cn, formatFileSize } from "@/lib/utils";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { apiFetch } from "@/lib/browser-navigation";

interface NavItem {
  id: string;
  icon: typeof Mail;
  labelKey: string;
  href: string;
  hidden?: boolean;
  badge?: number;
}

interface NavigationRailProps {
  orientation?: "vertical" | "horizontal";
  collapsed?: boolean;
  className?: string;
  quota?: { used: number; total: number } | null;
  isPushConnected?: boolean;
  onLogout?: () => void;
  onShowShortcuts?: () => void;
  onManageApps?: () => void;
  onInlineApp?: (appId: string, url: string, name: string) => void;
  onCloseInlineApp?: () => void;
  activeAppId?: string | null;
}

function StorageQuotaCircle({ quota, usagePercent }: { quota: { used: number; total: number }; usagePercent: number }) {
  const t = useTranslations("sidebar");
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPopoverStyle({
      position: "fixed",
      left: rect.right + 8,
      bottom: window.innerHeight - rect.bottom,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handleClick = (e: MouseEvent) => {
      if (
        buttonRef.current?.contains(e.target as Node) ||
        popoverRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, updatePosition]);

  const free = quota.total - quota.used;
  const strokeColor = usagePercent > 90
    ? "stroke-destructive"
    : usagePercent > 70
      ? "stroke-warning"
      : "stroke-success";

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className="relative w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors cursor-pointer"
        aria-label={t("storage")}
      >
        <svg className="w-8 h-8 -rotate-90" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="12" fill="none" className="stroke-muted" strokeWidth="3" />
          <circle
            cx="16" cy="16" r="12" fill="none"
            className={cn(strokeColor)}
            strokeWidth="3" strokeLinecap="round"
            strokeDasharray={`${(usagePercent / 100) * 75.4} 75.4`}
            style={{ transition: "stroke-dasharray 0.3s" }}
          />
        </svg>
        <span className="absolute text-[7px] font-bold text-muted-foreground tabular-nums">
          {Math.round(usagePercent)}%
        </span>
      </button>

      {open && createPortal(
        <div ref={popoverRef} style={popoverStyle} className="w-52 rounded-lg border border-border bg-background text-foreground shadow-lg p-3 z-50">
          <p className="text-xs font-semibold mb-2">{t("storage")}</p>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("storage_used")}</span>
              <span className="font-medium tabular-nums">{formatFileSize(quota.used)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("storage_free")}</span>
              <span className="font-medium tabular-nums">{formatFileSize(free)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("storage_total")}</span>
              <span className="font-medium tabular-nums">{formatFileSize(quota.total)}</span>
            </div>
          </div>
          <div className="mt-2.5 w-full bg-muted rounded-full h-1.5">
            <div
              className={cn(
                "h-1.5 rounded-full transition-all",
                usagePercent > 90
                  ? "bg-destructive"
                  : usagePercent > 70
                    ? "bg-warning"
                    : "bg-success"
              )}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1 tabular-nums">
            {Math.round(usagePercent)}% {t("storage_used").toLowerCase()}
          </p>
        </div>,
        document.body
      )}
    </div>
  );
}

export function NavigationRail({
  orientation = "vertical",
  collapsed = false,
  className,
  quota,
  isPushConnected,
  onLogout,
  onShowShortcuts,
  onManageApps,
  onInlineApp,
  onCloseInlineApp,
  activeAppId,
}: NavigationRailProps) {
  const t = useTranslations("sidebar");
  const pathname = usePathname();
  const { appLogoLightUrl, appLogoDarkUrl } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const { supportsCalendar } = useCalendarStore();
  const { mailboxes } = useEmailStore();
  const { supportsWebDAV } = useWebDAVStore();
  const sidebarApps = useSettingsStore((s) => s.sidebarApps);
  const showRailAccountList = useSettingsStore((s) => s.showRailAccountList);
  const sidebarAppsEnabled = usePolicyStore((s) => s.isFeatureEnabled('sidebarAppsEnabled'));
  const filesEnabled = usePolicyStore((s) => s.isFeatureEnabled('filesEnabled'));
  const visibleSidebarApps = sidebarAppsEnabled ? sidebarApps : [];
  const inboxUnread = mailboxes.find(m => m.role === "inbox")?.unreadEmails || 0;
  const [isStalwartAdmin, setIsStalwartAdmin] = useState(false);

  // Account list for rail
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const logout = useAuthStore((s) => s.logout);
  const logoutAll = useAuthStore((s) => s.logoutAll);
  const [logoutMenuOpen, setLogoutMenuOpen] = useState(false);
  const logoutBtnRef = useRef<HTMLButtonElement>(null);
  const logoutPopoverRef = useRef<HTMLDivElement>(null);
  const [logoutPopoverStyle, setLogoutPopoverStyle] = useState<React.CSSProperties>({});
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);

  const updateLogoutPosition = useCallback(() => {
    if (!logoutBtnRef.current) return;
    const rect = logoutBtnRef.current.getBoundingClientRect();
    setLogoutPopoverStyle({
      position: "fixed",
      left: rect.right + 8,
      bottom: Math.max(8, window.innerHeight - rect.bottom),
    });
  }, []);

  useEffect(() => {
    if (!logoutMenuOpen) return;
    updateLogoutPosition();
    const handleClickOutside = (e: MouseEvent) => {
      if (
        logoutBtnRef.current?.contains(e.target as Node) ||
        logoutPopoverRef.current?.contains(e.target as Node)
      ) return;
      setLogoutMenuOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLogoutMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [logoutMenuOpen, updateLogoutPosition]);

  useEffect(() => {
    let cancelled = false;
    const headers = getActiveAccountSlotHeaders();
    if (!headers['X-JMAP-Cookie-Slot']) return;
    apiFetch('/api/admin/auth', { headers })
      .then(res => res.json())
      .then(data => {
        if (cancelled || !data.stalwartAdmin) return;
        setIsStalwartAdmin(true);
        if (!data.authenticated) {
          // Pre-create admin session so /admin works even after full page navigation
          apiFetch('/api/admin/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ stalwartAuth: true }),
          }).catch(() => {});
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const navItems: NavItem[] = [
    { id: "mail", icon: Mail, labelKey: "mail", href: "/", badge: inboxUnread },
    { id: "calendar", icon: Calendar, labelKey: "calendar", href: "/calendar", hidden: !supportsCalendar },
    { id: "contacts", icon: BookUser, labelKey: "contacts", href: "/contacts" },
    { id: "files", icon: HardDrive, labelKey: "files", href: "/files", hidden: supportsWebDAV === false || !filesEnabled },
  ];

  const isSettingsActive = !activeAppId && pathname.startsWith("/settings");

  const visibleItems = navItems.filter((item) => !item.hidden);

  const getIsActive = (href: string) => {
    if (activeAppId) return false;
    if (href === "/") {
      return pathname === "/" || pathname === "";
    }
    return pathname.startsWith(href);
  };

  if (orientation === "horizontal") {
    return (
      <nav
        className={cn("flex items-center bg-background border-t border-border shrink-0 overflow-x-auto mobile-scroll-hidden", className)}
        role="navigation"
        aria-label={t("nav_label")}
      >
        {visibleItems.map((item) => {
          const isActive = getIsActive(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.id}
              href={item.href}
              onClick={activeAppId ? () => onCloseInlineApp?.() : undefined}
              className={cn(
                "flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px]",
                "transition-colors duration-150",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <div className="relative">
                <Icon className="w-5 h-5" />
                {item.badge != null && item.badge > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 flex items-center justify-center min-w-[16px] h-4 text-[10px] font-bold rounded-full bg-red-500 text-white px-1">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                )}
                {isActive && (
                  <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded-full bg-primary" />
                )}
              </div>
              <span className="text-[10px] font-medium leading-tight truncate max-w-full">{t(item.labelKey)}</span>
            </Link>
          );
        })}

        {/* Custom sidebar apps (per-app mobile visibility) */}
        {visibleSidebarApps.filter((app) => app.showOnMobile).map((app) => {
          const AppIcon = lucideIcons[app.icon as keyof typeof lucideIcons] as LucideIcon | undefined;
          const isActive = activeAppId === app.id;
          return (
            <button
              key={app.id}
              onClick={() => {
                if (isActive) {
                  onCloseInlineApp?.();
                } else if (app.openMode === 'tab') {
                  window.open(app.url, '_blank', 'noopener,noreferrer');
                } else {
                  onInlineApp?.(app.id, app.url, app.name);
                }
              }}
              className={cn(
                "flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px]",
                "transition-colors duration-150",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <div className="relative">
                {AppIcon ? <AppIcon className="w-5 h-5" /> : null}
                {isActive && (
                  <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded-full bg-primary" />
                )}
              </div>
              <span className="text-[10px] font-medium leading-tight truncate max-w-full">{app.name}</span>
            </button>
          );
        })}

        {/* Admin (Stalwart admins) */}
        {isStalwartAdmin && (
          <NextLink
            href="/admin"
            className={cn(
              "flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px]",
              "transition-colors duration-150",
              "text-muted-foreground hover:text-foreground"
            )}
          >
            <Shield className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight truncate max-w-full">{t("admin") || "Admin"}</span>
          </NextLink>
        )}

        {/* Settings */}
        <Link
          href="/settings"
          onClick={activeAppId ? () => onCloseInlineApp?.() : undefined}
          className={cn(
            "flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px]",
            "transition-colors duration-150",
            isSettingsActive
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
          aria-current={isSettingsActive ? "page" : undefined}
        >
          <div className="relative">
            <Settings className="w-5 h-5" />
            {isSettingsActive && (
              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded-full bg-primary" />
            )}
          </div>
          <span className="text-[10px] font-medium leading-tight truncate max-w-full">{t("settings")}</span>
        </Link>
      </nav>
    );
  }

  const quotaUsagePercent = quota && quota.total > 0 ? Math.min((quota.used / quota.total) * 100, 100) : 0;

  return (
    <div
      className={cn(
        "flex flex-col h-full",
        collapsed ? "items-center" : "",
        className
      )}
    >
      {(() => {
        const logoUrl = resolvedTheme === 'dark' ? (appLogoDarkUrl || appLogoLightUrl) : (appLogoLightUrl || appLogoDarkUrl);
        return logoUrl ? (
          <div className="flex items-center justify-center py-3 px-1">
            <img
              src={logoUrl}
              alt=""
              className="w-8 h-8 object-contain"
            />
          </div>
        ) : null;
      })()}

      <nav
        className={cn(
          "flex flex-col",
          collapsed ? "items-center gap-1 py-3 px-1" : "gap-0.5 py-2 px-2",
        )}
        role="navigation"
        aria-label={t("nav_label")}
      >
        {visibleItems.map((item) => {
          const isActive = getIsActive(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.id}
              href={item.href}
              onClick={activeAppId ? () => onCloseInlineApp?.() : undefined}
              data-tour={`nav-${item.id}`}
              className={cn(
                "relative flex items-center gap-2.5 rounded-md transition-colors duration-150",
                collapsed
                  ? "justify-center w-10 h-10"
                  : "px-2.5 text-sm",
                "max-lg:min-h-[44px]",
                isActive
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              aria-current={isActive ? "page" : undefined}
              title={collapsed ? t(item.labelKey) : undefined}
              style={collapsed ? undefined : { paddingBlock: 'var(--density-sidebar-py)' }}
            >
              <Icon className={cn("w-[18px] h-[18px] flex-shrink-0", isActive && "text-primary")} />
              {!collapsed && <span className="truncate">{t(item.labelKey)}</span>}
              {item.badge != null && item.badge > 0 && (
                <span className={cn(
                  "absolute flex items-center justify-center min-w-[16px] h-4 text-[10px] font-bold rounded-full bg-red-500 text-white px-1",
                  collapsed ? "-top-0.5 -right-0.5" : "right-1.5"
                )}>
                  {item.badge > 99 ? "99+" : item.badge}
                </span>
              )}
            </Link>
          );
        })}

        {/* Custom sidebar apps */}
        {visibleSidebarApps.length > 0 && (
          <div
            className={cn(
              "border-t",
              collapsed ? "w-8 mx-auto my-1 pt-1" : "mx-2 my-0.5 pt-0.5"
            )}
            style={{ borderColor: 'rgba(128, 128, 128, 0.3)' }}
          />
        )}
        {visibleSidebarApps.map((app) => {
          const AppIcon = lucideIcons[app.icon as keyof typeof lucideIcons] as LucideIcon | undefined;
          const isActive = activeAppId === app.id;
          return (
            <button
              key={app.id}
              onClick={() => {
                if (isActive) {
                  onCloseInlineApp?.();
                } else if (app.openMode === 'tab') {
                  window.open(app.url, '_blank', 'noopener,noreferrer');
                } else {
                  onInlineApp?.(app.id, app.url, app.name);
                }
              }}
              className={cn(
                "relative flex items-center gap-2.5 rounded-md transition-colors duration-150",
                collapsed
                  ? "justify-center w-10 h-10"
                  : "px-2.5 text-sm",
                "max-lg:min-h-[44px]",
                isActive
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              title={collapsed ? app.name : undefined}
              style={collapsed ? undefined : { paddingBlock: 'var(--density-sidebar-py)' }}
            >
              {AppIcon ? <AppIcon className={cn("w-[18px] h-[18px] flex-shrink-0", isActive && "text-primary")} /> : null}
              {!collapsed && <span className="truncate">{app.name}</span>}
            </button>
          );
        })}

        {/* Manage apps button */}
        {onManageApps && (
          <button
            onClick={onManageApps}
            className={cn(
              "relative flex items-center gap-2.5 rounded-md transition-colors duration-150",
              collapsed
                ? "justify-center w-10 h-10"
                : "px-2.5 text-sm",
              "max-lg:min-h-[44px]",
              "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
            title={collapsed ? t("add_app") : undefined}
            style={collapsed ? undefined : { paddingBlock: 'var(--density-sidebar-py)' }}
          >
            <Plus className="w-[18px] h-[18px] flex-shrink-0" />
            {!collapsed && <span className="truncate">{t("add_app")}</span>}
          </button>
        )}
      </nav>

      <PluginSlot name="navigation-rail-bottom" />

      {/* Footer: Admin + Settings + Help + Storage Quota + Sign Out + Push Status */}
      <div className="mt-auto flex flex-col items-center gap-2 pb-3 px-1">
        {isStalwartAdmin && (
          <NextLink
            href="/admin"
            className="flex items-center justify-center w-10 h-10 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
            title={t("admin") || "Admin"}
          >
            <Shield className="w-[18px] h-[18px]" />
          </NextLink>
        )}

        <Link
          href="/settings"
          onClick={activeAppId ? () => onCloseInlineApp?.() : undefined}
          data-tour="nav-settings"
          className={cn(
            "flex items-center justify-center w-10 h-10 rounded-md transition-colors",
            isSettingsActive
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
          title={t("settings")}
          aria-current={isSettingsActive ? "page" : undefined}
        >
          <Settings className="w-[18px] h-[18px]" />
        </Link>

        <div className="w-8 border-t" style={{ borderColor: 'rgba(128, 128, 128, 0.3)' }} />

        {onShowShortcuts && (
          <button
            onClick={onShowShortcuts}
            data-tour="nav-shortcuts"
            className="flex items-center justify-center w-10 h-10 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={t("keyboard_shortcuts")}
          >
            <Keyboard className="w-[18px] h-[18px]" />
          </button>
        )}
        {!onShowShortcuts && (
          <>
            <button
              onClick={() => setShowShortcutsModal(true)}
              data-tour="nav-shortcuts"
              className="flex items-center justify-center w-10 h-10 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={t("keyboard_shortcuts")}
            >
              <Keyboard className="w-[18px] h-[18px]" />
            </button>
            <KeyboardShortcutsModal
              isOpen={showShortcutsModal}
              onClose={() => setShowShortcutsModal(false)}
            />
          </>
        )}

        {quota && quota.total > 0 && (
          <div data-tour="storage-quota">
            <StorageQuotaCircle quota={quota} usagePercent={quotaUsagePercent} />
          </div>
        )}

        {onLogout && showRailAccountList && accounts.length > 0 && (
          <>
            <div className="w-8 border-t my-1" style={{ borderColor: 'rgba(128, 128, 128, 0.3)' }} />

            {/* Account circles */}
            <div className="flex flex-col items-center gap-3">
            {accounts.map((account) => {
              const isActive = account.id === activeAccountId;
              const initials = getInitials(account.displayName || account.label, account.email || account.username);
              return (
                <button
                  key={account.id}
                  onClick={() => {
                    if (!isActive) switchAccount(account.id);
                  }}
                  className={cn(
                    "relative flex items-center justify-center w-8 h-8 rounded-full text-white text-[11px] font-medium transition-all flex-shrink-0",
                    isActive
                      ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                      : "opacity-70 hover:opacity-100"
                  )}
                  style={{ backgroundColor: account.avatarColor }}
                  title={`${account.displayName || account.label} (${account.email || account.username})`}
                >
                  {initials}
                  {isActive && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-primary flex items-center justify-center">
                      <Check className="w-2 h-2 text-primary-foreground" />
                    </span>
                  )}
                </button>
              );
            })}
            </div>

            {/* Logout button with popover */}
            <button
              ref={logoutBtnRef}
              onClick={() => setLogoutMenuOpen(!logoutMenuOpen)}
              className="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={t("sign_out")}
              aria-expanded={logoutMenuOpen}
              aria-haspopup="true"
            >
              <LogOut className="w-4 h-4" />
            </button>

            {logoutMenuOpen && createPortal(
              <div
                ref={logoutPopoverRef}
                style={logoutPopoverStyle}
                className="w-56 rounded-lg border border-border bg-background text-foreground shadow-lg z-50 overflow-hidden"
                role="menu"
              >
                <button
                  onClick={() => { setLogoutMenuOpen(false); logout(); }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                  role="menuitem"
                >
                  <LogOut className="w-4 h-4" />
                  {t("sign_out")}
                </button>
                {accounts.length > 1 && (
                  <button
                    onClick={() => { setLogoutMenuOpen(false); logoutAll(); }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-destructive hover:bg-muted transition-colors"
                    role="menuitem"
                  >
                    <LogOut className="w-4 h-4" />
                    {t("sign_out_all")}
                  </button>
                )}
              </div>,
              document.body
            )}
          </>
        )}

        {onLogout && !showRailAccountList && (
          <AccountSwitcher variant="rail" />
        )}
      </div>
    </div>
  );
}
