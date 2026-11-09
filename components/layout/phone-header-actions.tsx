"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { MoreVertical, Terminal, Bell } from "@/components/icons";
import { IconButton } from "@/components/ui/icon-button";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { AccountSwitcher } from "@/components/layout/account-switcher";
import { PluginActions } from "@/components/plugins/plugin-actions";
import { AppSidePanelPhoneButton } from "@/components/plugins/app-side-panel";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useIsDesktop, useIsMobile } from "@/hooks/use-media-query";
import { openCommandPalette } from "@/lib/app-commands";
import { cn } from "@/lib/utils";
import {
  NotificationSheet,
  formatBadgeCount,
  useUnreadNotificationCount,
} from "@/components/notifications/notification-center";

/** Plugin buttons in the top bar are not about any one item. */
const TOP_BAR_CONTEXT: Record<string, unknown> = {};

export interface PhoneHeaderMenuProps {
  /**
   * The app's own entries, listed above the shell's. They get the function
   * that closes the menu, to call when one is picked.
   */
  menuItems?: (close: () => void) => ReactNode;
}

/**
 * The phone header's overflow menu: the app's own entries if it has any, the
 * notifications (the desktop bell), the command palette (no Ctrl+K on a
 * phone) and what the desktop top bar shows as buttons (plugin
 * top-bar-actions) and has no room for here.
 */
export function PhoneHeaderMenu({ menuItems }: PhoneHeaderMenuProps) {
  const t = useTranslations("top_bar");
  const tPalette = useTranslations("command_palette");
  const tNotifications = useTranslations("notification_center");
  const unread = useUnreadNotificationCount();
  const [showNotifications, setShowNotifications] = useState(false);
  const menu = useContextMenu<null>();
  const open = menu.contextMenu.isOpen;
  const close = menu.closeContextMenu;

  const appItems = menuItems?.(close);

  return (
    <div className="relative">
      <IconButton
        size="icon-lg"
        onClick={(e) => (open ? close() : menu.openContextMenuFrom(e.currentTarget, null, "end"))}
        className={cn(open && "bg-accent")}
        label={unread > 0 ? `${t("more")} (${tNotifications("unread_count", { count: unread })})` : t("more")}
        title=""
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVertical />
        {unread > 0 && (
          <span className="absolute top-2 end-2 w-2 h-2 rounded-full bg-red-500 ring-2 ring-background" aria-hidden="true" />
        )}
      </IconButton>
      <ContextMenu ref={menu.menuRef} isOpen={open} position={menu.contextMenu.position} onClose={close} label={t("more")}>
          {appItems && (
            <>
              {appItems}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            icon={Bell}
            label={tNotifications("title")}
            badge={unread > 0 ? formatBadgeCount(unread) : undefined}
            onClick={() => { close(); setShowNotifications(true); }}
          />
          <ContextMenuItem
            icon={Terminal}
            label={tPalette("title")}
            onClick={() => { close(); openCommandPalette(); }}
          />
          <PluginActions surface="top-bar-actions" context={TOP_BAR_CONTEXT} variant="menu" onRan={close} />
      </ContextMenu>
      {showNotifications && <NotificationSheet onClose={() => setShowNotifications(false)} />}
    </div>
  );
}

export interface PhoneHeaderActionsProps extends PhoneHeaderMenuProps {
  /**
   * Below which width the app shows the phone shell (bottom tab bar, no
   * rail): "md" for apps that keep the rail on a tablet, "lg" for those that
   * use the phone shell up to the desktop. Above it nothing is drawn, as the
   * rail or the Mountain View top bar holds these controls there.
   */
  below?: "md" | "lg";
  className?: string;
  /** Mountain View: opens the merged across-accounts inbox from the avatar's popover. */
  onSelectAllInboxes?: () => void;
  allInboxesSelected?: boolean;
}

/**
 * The cluster at the end of every app's phone header (answer 12 of the
 * 2026-10-27 usability test): a ⋮ with notifications and the command palette,
 * then the account avatar. Drop it in as the last child of the header row.
 */
export function PhoneHeaderActions({
  below = "lg",
  className,
  menuItems,
  onSelectAllInboxes,
  allInboxesSelected = false,
}: PhoneHeaderActionsProps) {
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const shown = below === "md" ? isMobile : !isDesktop;
  if (!shown) return null;

  return (
    <div data-phone-header-actions="" className={cn("flex items-center gap-1 flex-shrink-0 ms-auto", className)}>
      {/* A plugin's side panel of this view, which opens as a dialog on a phone. */}
      <AppSidePanelPhoneButton />
      <PhoneHeaderMenu menuItems={menuItems} />
      {/* Which account you are in is otherwise only visible in Settings.
          Last, so it sits on the far edge, mirrored under RTL by the flex row. */}
      <AccountSwitcher
        variant="header"
        onSelectAllInboxes={onSelectAllInboxes}
        allInboxesSelected={allInboxesSelected}
      />
    </div>
  );
}

export interface PhoneAppHeaderProps extends PhoneHeaderActionsProps {
  title: string;
  /** Controls drawn before the title, such as a back or menu button. */
  leading?: ReactNode;
}

/** A whole phone header for a screen that has none of its own: title, then the shared cluster. */
export function PhoneAppHeader({ title, leading, ...actions }: PhoneAppHeaderProps) {
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const shown = (actions.below ?? "lg") === "md" ? isMobile : !isDesktop;
  if (!shown) return null;
  return (
    <header className="flex items-center gap-2 h-14 shrink-0 border-b border-border bg-background px-4">
      {leading}
      <h1 className="font-semibold text-lg truncate min-w-0" title={title}>{title}</h1>
      <PhoneHeaderActions {...actions} />
    </header>
  );
}
