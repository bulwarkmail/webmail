"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Mail, Calendar, BookUser, HardDrive, Settings, LogOut } from "lucide-react";
import { usePathname, Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useCalendarStore } from "@/stores/calendar-store";
import { useEmailStore } from "@/stores/email-store";
import { useWebDAVStore } from "@/stores/webdav-store";
import { cn, formatFileSize } from "@/lib/utils";

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
    ? "stroke-red-500 dark:stroke-red-400"
    : usagePercent > 70
      ? "stroke-amber-500 dark:stroke-amber-400"
      : "stroke-green-500 dark:stroke-green-400";

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
                  ? "bg-red-500 dark:bg-red-400"
                  : usagePercent > 70
                    ? "bg-amber-500 dark:bg-amber-400"
                    : "bg-green-500 dark:bg-green-400"
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
}: NavigationRailProps) {
  const t = useTranslations("sidebar");
  const pathname = usePathname();
  const { supportsCalendar } = useCalendarStore();
  const { mailboxes } = useEmailStore();
  const { supportsWebDAV } = useWebDAVStore();
  const inboxUnread = mailboxes.find(m => m.role === "inbox")?.unreadEmails || 0;

  const navItems: NavItem[] = [
    { id: "mail", icon: Mail, labelKey: "mail", href: "/", badge: inboxUnread },
    { id: "calendar", icon: Calendar, labelKey: "calendar", href: "/calendar", hidden: !supportsCalendar },
    { id: "contacts", icon: BookUser, labelKey: "contacts", href: "/contacts" },
    { id: "files", icon: HardDrive, labelKey: "files", href: "/files", hidden: supportsWebDAV === false },
    { id: "settings", icon: Settings, labelKey: "settings", href: "/settings" },
  ];

  const visibleItems = navItems.filter((item) => !item.hidden);

  const getIsActive = (href: string) => {
    if (href === "/") {
      return pathname === "/" || pathname === "";
    }
    return pathname.startsWith(href);
  };

  if (orientation === "horizontal") {
    return (
      <nav
        className={cn("flex items-center justify-around bg-background border-t border-border shrink-0", className)}
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
              className={cn(
                "flex flex-col items-center justify-center gap-1 py-2 px-3 min-w-[64px] min-h-[44px]",
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
              <span className="text-[10px] font-medium leading-tight">{t(item.labelKey)}</span>
            </Link>
          );
        })}
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
      </nav>

      {/* Footer: Storage Quota + Sign Out + Push Status */}
      <div className="mt-auto flex flex-col items-center gap-2 pb-3 px-1 border-t border-border pt-2">
        {quota && quota.total > 0 && (
          <StorageQuotaCircle quota={quota} usagePercent={quotaUsagePercent} />
        )}

        {isPushConnected != null && (
          <span
            className="relative group"
            title={isPushConnected ? t("push_connected") : t("push_disconnected")}
          >
            <span
              className={cn(
                "inline-block w-1.5 h-1.5 rounded-full transition-all duration-300",
                isPushConnected ? "bg-green-500" : "bg-muted-foreground/40"
              )}
            />
          </span>
        )}

        {onLogout && (
          <button
            onClick={onLogout}
            className="flex items-center justify-center w-10 h-10 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={t("sign_out")}
          >
            <LogOut className="w-[18px] h-[18px]" />
          </button>
        )}
      </div>
    </div>
  );
}
