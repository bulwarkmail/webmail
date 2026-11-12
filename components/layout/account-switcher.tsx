"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useId } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, LogOut, Mails, Star, ChevronDown, AlertCircle, GripVertical, X, Settings, Cloud } from "@/components/icons";
import { useTranslations } from "next-intl";
import type { Mailbox } from "@/lib/jmap/types";
import { useAccountStore, type AccountEntry } from "@/stores/account-store";
import { useDesktopPolicy } from "@/lib/desktop/policy";
import { accountRefusedByDesktopPolicy } from "@/lib/desktop/refused-accounts";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { HelpMenuItems } from "@/components/layout/help-links";
import { getMaxAccounts, sortDefaultFirst, reorderNonDefaultIds, accountRowText, accountAvatarName, accountSharesAddress } from "@/lib/account-utils";
import { inboxUnread, totalInboxUnread } from "@/lib/account-inbox-unread";
import { isDocumentRTL } from "@/i18n/direction";
import { cn, formatFileSize } from "@/lib/utils";
import { useRouter } from "@/i18n/navigation";
import { onRefusedLoginsChanged, siblingWaits, waitDate } from "@/lib/devices/wipe-state";
import { Avatar } from "@/components/ui/avatar";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { toUnicodeDomain, toUnicodeEmail } from "@/lib/idn";
import { buildSettingsPath } from "@/lib/deep-links";

interface AccountSwitcherProps {
  /** "rail" = small avatar only (NavigationRail), "expanded" = avatar + name + email (Sidebar) */
  variant?: "rail" | "expanded" | "header";
  className?: string;
  /**
   * Mountain View only: opens the one list that spans every account. It sits
   * at the head of the account popover, above the addresses it merges,
   * because it is the alternative to picking one of them. Omitted when the
   * unified view is off or out of reach, and then no row is drawn.
   */
  onSelectAllInboxes?: () => void;
  /** Whether that merged list is the one currently on screen. */
  allInboxesSelected?: boolean;
}

function AccountAvatar({ account, accounts, size = "sm" }: { account: AccountEntry; accounts: AccountEntry[]; size?: "sm" | "md" | "xl" }) {
  return (
    <Avatar
      name={accountAvatarName(account, accounts)}
      email={account.email || account.username}
      size="sm"
      className={cn(
        "flex-shrink-0",
        size === "md" && "w-9 h-9 text-sm",
        size === "xl" && "!w-20 !h-20 !text-2xl"
      )}
      disableFavicon
      fallbackColor={account.avatarColor}
    />
  );
}

/** The popover's unread badge: a count, capped, or nothing at all when there is none. */
function UnreadBadge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <span className="ms-auto shrink-0 text-xs font-medium tabular-nums text-primary">
      {count > 999 ? "999+" : count}
    </span>
  );
}

export function AccountSwitcher({
  variant = "rail",
  className,
  onSelectAllInboxes,
  allInboxesSelected = false,
}: AccountSwitcherProps) {
  const t = useTranslations("sidebar");
  const tUnread = useTranslations("account_unread");
  const tAccounts = useTranslations("settings.account.accounts");
  const tFolders = useTranslations("uxs_folders");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  // The popover is portalled to <body>, so it lands at the very end of the
  // reading order. Without this the menu is unreachable for screen reader and
  // keyboard users even though it is on screen.
  const closeMenu = useCallback(() => setOpen(false), []);
  const { menuRef: popoverRef, onKeyDown: handleMenuKeyDown } = useMenuNavigation<HTMLDivElement>({
    open,
    onClose: closeMenu,
    triggerRef: buttonRef,
  });

  // The header avatar is Mountain View's account control; the same component
  // in the rail and the sidebar keeps the list it has always had, so the
  // default layout is untouched.
  const mvPopover = useSettingsStore((s) => s.interfaceLayout === "mountain-view") && variant === "header";
  const accountMailboxes = useEmailStore((s) => s.accountMailboxes);
  const quota = useEmailStore((s) => s.quota);
  const tCommon = useTranslations("common");
  const ownMailboxes = useEmailStore((s) => s.mailboxes);

  const storedAccounts = useAccountStore((s) => s.accounts);
  const devicePolicy = useDesktopPolicy();
  // One on a server the device's OS policy refuses is stopped, and isn't on offer here.
  const accounts = useMemo(
    () => (devicePolicy.AllowedJmapServers.value ? storedAccounts.filter((account) => !accountRefusedByDesktopPolicy(account, devicePolicy)) : storedAccounts),
    [storedAccounts, devicePolicy],
  );
  const setDefaultAccount = useAccountStore((s) => s.setDefaultAccount);
  const reorderAccounts = useAccountStore((s) => s.reorderAccounts);
  // Read activeAccountId from authStore so the selector matches the actually-loaded
  // session (primaryIdentity, JMAP client). accountStore.activeAccountId is a separate
  // persisted copy that can drift out of sync across hydration / partial persist writes.
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const activeAccount = accounts.find((a) => a.id === activeAccountId);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const logout = useAuthStore((s) => s.logout);
  const logoutAll = useAuthStore((s) => s.logoutAll);
  const tWipe = useTranslations("offlineWipe");
  // An account that signed out by itself beside this one: its data waits.
  const [, noteWaitsChanged] = useState(0);
  useEffect(() => onRefusedLoginsChanged(() => noteWaitsChanged((count) => count + 1)), []);
  const waiting = siblingWaits(activeAccountId);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const rtl = isDocumentRTL();
    if (variant === "header") {
      // Anchored at the inline-end edge of the top bar, so the menu drops
      // down and is pinned by its own trailing edge — anchoring by the
      // leading edge (as "expanded" does) runs it off-screen, which is
      // exactly what happened in RTL where that edge is the left one.
      setPopoverStyle({
        position: "fixed",
        top: rect.bottom + 4,
        maxWidth: "calc(100vw - 16px)",
        ...(rtl
          ? { left: Math.max(8, rect.left) }
          : { right: Math.max(8, window.innerWidth - rect.right) }),
      });
    } else if (variant === "rail") {
      setPopoverStyle(
        rtl
          ? {
              position: "fixed",
              right: window.innerWidth - rect.left + 8,
              bottom: Math.max(8, window.innerHeight - rect.bottom),
            }
          : {
              position: "fixed",
              left: rect.right + 8,
              bottom: Math.max(8, window.innerHeight - rect.bottom),
            }
      );
    } else {
      setPopoverStyle(
        rtl
          ? {
              position: "fixed",
              right: window.innerWidth - rect.right,
              top: rect.bottom + 4,
            }
          : {
              position: "fixed",
              left: rect.left,
              top: rect.bottom + 4,
            }
      );
    }
  }, [variant]);

  // Position before the first paint - the portalled popover would otherwise
  // render one frame as an unpositioned block at the end of <body>, shifting
  // the page layout for a split second.
  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        buttonRef.current?.contains(e.target as Node) ||
        popoverRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, popoverRef]);

  const handleSwitch = async (accountId: string) => {
    if (accountId === activeAccountId) return;
    setOpen(false);
    await switchAccount(accountId);
  };

  const handleAddAccount = () => {
    setOpen(false);
    router.push(`/login?mode=add-account` as never);
  };

  const handleManageAccounts = () => {
    setOpen(false);
    router.push(buildSettingsPath("account", "browser") as never);
  };

  const handleLogout = () => {
    setOpen(false);
    logout();
  };

  const handleLogoutAll = () => {
    setOpen(false);
    logoutAll();
  };

  const handleSetDefault = (accountId: string) => {
    setDefaultAccount(accountId);
  };

  // Display order: default account pinned to the top, the rest reorderable.
  const displayAccounts = useMemo(() => sortDefaultFirst(accounts), [accounts]);

  // Drag-to-rearrange (non-default accounts only; the default stays pinned).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const resetDrag = () => { setDragId(null); setDragOverId(null); };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (e: React.DragEvent, overId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overId !== dragOverId) setDragOverId(overId);
  };
  // Alt+Shift+↑ / ↓ on an account moves it, as dragging does (WCAG 2.1.1);
  // Settings > Accounts has Move up / Move down buttons for the same order.
  const handleMoveKey = (e: React.KeyboardEvent, accountId: string) => {
    if (!e.altKey || !e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const movable = displayAccounts.filter((a) => !a.isDefault);
    const index = movable.findIndex((a) => a.id === accountId);
    const other = movable[index + (e.key === "ArrowUp" ? -1 : 1)];
    if (index < 0 || !other) return;
    e.preventDefault();
    e.stopPropagation();
    const next = reorderNonDefaultIds(accounts, accountId, other.id);
    if (next) reorderAccounts(next);
  };

  const handleDrop = (e: React.DragEvent, overId: string) => {
    e.preventDefault();
    if (dragId) {
      const next = reorderNonDefaultIds(accounts, dragId, overId);
      if (next) reorderAccounts(next);
    }
    resetDrag();
  };

  // Show the account's own identity, not the preferred sending identity -
  // primaryIdentity can be an alias (e.g. info@korazo.net) that differs from
  // the actually logged-in account (info@linusrath.de).
  // IDN domains arrive in their ASCII (xn--) form; show them as written (#1100).
  // A name another account shares gives way to the address (accountRowText).
  // The rows below lead with the address when two accounts share a name, so
  // they differ in their bold line. The button names one account only, with
  // its address under it, so its name stays put when another account is
  // added (settings-14).
  const activeText = activeAccount ? accountRowText(activeAccount, [activeAccount]) : null;
  const displayName = toUnicodeEmail(activeText?.title || "");
  const displaySubtitle = toUnicodeEmail(activeText?.subtitle || "");
  const displayEmail = toUnicodeEmail(activeAccount?.email || activeAccount?.username || "");

  // Mountain View leads its popover with the account you are already in - large avatar,
  // name, address - and lists only the others underneath, since choosing one is
  // the point of opening it. Every row carries the unread waiting there, so the
  // choice can be made without visiting each account in turn.
  const listedAccounts = mvPopover
    ? displayAccounts.filter((account) => account.id !== activeAccountId)
    : displayAccounts;
  const unreadByAccount: Record<string, Mailbox[] | undefined> = activeAccountId
    ? { ...accountMailboxes, [activeAccountId]: ownMailboxes }
    : accountMailboxes;
  // With several accounts every row carries the unread waiting in its Inbox, as Gmail and
  // Outlook show. A single account's count is already on its Inbox in the folder list.
  const severalAccounts = accounts.length > 1;
  const unreadFor = (account: AccountEntry) =>
    mvPopover || severalAccounts ? inboxUnread(unreadByAccount[account.id]) : undefined;
  // The server is only worth a line when it is what tells two rows apart.
  const sharesAddress = (account: AccountEntry) => accountSharesAddress(account, accounts);
  const connectedIds = accounts.filter((account) => account.isConnected).map((account) => account.id);
  const allInboxesUnread = totalInboxUnread(connectedIds, unreadByAccount);
  // What waits in the accounts not on screen: a dot on the avatar says so.
  const othersUnread = totalInboxUnread(connectedIds.filter((id) => id !== activeAccountId), unreadByAccount);
  const othersUnreadText = othersUnread > 0 ? tUnread("others", { count: othersUnread }) : null;

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        data-testid="account-switcher"
        data-plugin-list-avoid=""
        data-active-account-id={activeAccountId ?? undefined}
        className={cn(
          // Round under Mountain View, like every other button in its top bar.
          "flex items-center gap-2 transition-colors",
          mvPopover ? "rounded-full" : "rounded-md",
          variant !== "expanded"
            ? "justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 hover:bg-muted"
            : "w-full px-2 py-1.5 hover:bg-muted text-start min-w-0",
          className
        )}
        title={[displayName, displaySubtitle, variant !== "expanded" ? othersUnreadText : null].filter(Boolean).join("\n")}
        aria-label={othersUnreadText ? `${t("switch_account")}, ${othersUnreadText}` : t("switch_account")}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
      >
        {activeAccount ? (
          <>
            <span className="relative flex-shrink-0">
              <AccountAvatar account={activeAccount} accounts={accounts} size={variant === "expanded" ? "md" : "sm"} />
              {othersUnreadText && (
                <span
                  aria-hidden="true"
                  data-testid="other-accounts-unread"
                  className="absolute -top-0.5 -end-0.5 w-2.5 h-2.5 rounded-full bg-primary ring-2 ring-background"
                />
              )}
            </span>
            {variant === "expanded" && (
              <>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
                  {displaySubtitle && <p className="text-xs text-muted-foreground truncate">{displaySubtitle}</p>}
                </div>
                <ChevronDown className={cn("w-3.5 h-3.5 text-muted-foreground flex-shrink-0 transition-transform", open && "rotate-180")} />
              </>
            )}
          </>
        ) : (
          <div className={cn(
            "rounded-full bg-muted flex items-center justify-center text-muted-foreground",
            variant === "expanded" ? "w-9 h-9 text-sm" : "w-8 h-8 text-xs"
          )}>
            ?
          </div>
        )}
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          style={popoverStyle}
          className={cn(
            "text-foreground shadow-lg z-50 overflow-hidden",
            // Width and radius come from the layout's own tokens, keyed on the
            // attribute below. Under Mountain View it is Gmail's tinted card
            // holding a white one, with a close button in the corner.
            mvPopover ? "shadow-xl bg-[var(--mv-search-bg)] p-3 max-h-[calc(100dvh-5rem)] overflow-y-auto" : "w-72 rounded-lg border border-border bg-background"
          )}
          data-mv-account-popover={mvPopover ? "" : undefined}
          role="menu"
          id={menuId}
          aria-label={t("switch_account")}
          onKeyDown={handleMenuKeyDown}
        >
          {mvPopover && (
            <div className="flex justify-end pb-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                aria-label={tCommon("close")}
                title={tCommon("close")}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          )}

          {mvPopover && activeAccount && (
            <div className="flex items-center gap-4 rounded-t-3xl bg-background px-4 pt-4 pb-3" data-mv-account-current="">
              <AccountAvatar account={activeAccount} accounts={accounts} size="xl" />
              <div className="min-w-0 flex-1">
                <p className="text-lg leading-6 wrap-anywhere">{displayName}</p>
                {displaySubtitle && <p className="text-sm text-muted-foreground wrap-anywhere">{displaySubtitle}</p>}
              </div>
            </div>
          )}

          {mvPopover && onSelectAllInboxes && (
            <div className="bg-background border-t border-border/60">
              <button
                type="button"
                role="menuitem"
                data-testid="all-inboxes"
                onClick={() => {
                  setOpen(false);
                  onSelectAllInboxes();
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 text-start text-sm transition-colors",
                  allInboxesSelected ? "bg-accent/50 font-medium" : "hover:bg-muted"
                )}
              >
                <Mails className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{t("unified_inbox")}</span>
                <UnreadBadge count={allInboxesUnread} />
              </button>
            </div>
          )}

          {/* Account List. Under Mountain View the active account is already the
              card above, so with a single login there is no list to draw. */}
          <div
            className={cn(
              "py-1 max-h-64 overflow-y-auto",
              mvPopover && "bg-background border-t border-border/60 max-h-none",
              mvPopover && listedAccounts.length === 0 && "hidden"
            )}
          >
            {listedAccounts.map((account) => {
              const isActive = account.id === activeAccountId;
              const isDraggable = !account.isDefault && accounts.length > 2;
              const text = accountRowText(account, accounts);
              return (
                <div
                  key={account.id}
                  draggable={isDraggable}
                  onDragStart={isDraggable ? (e) => handleDragStart(e, account.id) : undefined}
                  onDragOver={isDraggable ? (e) => handleDragOver(e, account.id) : undefined}
                  onDrop={isDraggable ? (e) => handleDrop(e, account.id) : undefined}
                  onDragEnd={isDraggable ? resetDrag : undefined}
                  className={cn(
                    "group/acct relative",
                    dragId === account.id && "opacity-50",
                    dragOverId === account.id && dragId !== account.id && "border-t-2 border-primary"
                  )}
                >
                <button
                  onClick={() => handleSwitch(account.id)}
                  onKeyDown={isDraggable ? (e) => handleMoveKey(e, account.id) : undefined}
                  aria-keyshortcuts={isDraggable ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
                  data-testid="account-option"
                  data-account-id={account.id}
                  data-account-email={account.email || account.username}
                  className={cn(
                    "w-full flex items-start gap-3 px-3 py-2.5 text-start transition-colors",
                    isActive ? "bg-accent/50" : "hover:bg-muted",
                    isDraggable && "pe-7"
                  )}
                  role="menuitem"
                  disabled={isActive}
                >
                  <div className="relative flex-shrink-0">
                    <AccountAvatar account={account} accounts={accounts} size="md" />
                    {isActive && (
                      <div className="absolute -bottom-0.5 -end-0.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-primary-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-sm font-medium wrap-anywhere" title={toUnicodeEmail(text.title)}>
                        {toUnicodeEmail(text.title)}
                      </span>
                      {account.isDefault && accounts.length > 1 && (
                        <span title={tAccounts("default_badge")} className="flex-shrink-0 inline-flex">
                          <Star className="w-3 h-3 text-amber-500 fill-amber-500" aria-label={tAccounts("default_badge")} />
                        </span>
                      )}
                      <UnreadBadge count={unreadFor(account)} />
                    </div>
                    {text.subtitle && (
                      <p className="text-xs text-muted-foreground wrap-anywhere" title={toUnicodeEmail(text.subtitle)}>
                        {toUnicodeEmail(text.subtitle)}
                      </p>
                    )}
                    {/* The server line: only for an account in trouble, or
                        when two accounts have the same address. */}
                    {(account.hasError || sharesAddress(account)) && (
                      <div className="flex items-center gap-1 mt-0.5" data-testid="account-server">
                        {account.hasError && <AlertCircle className="w-3 h-3 text-destructive" />}
                        <span className="text-xs text-muted-foreground truncate">
                          {(() => { try { return toUnicodeDomain(new URL(account.serverUrl).hostname); } catch { return account.serverUrl; } })()}
                        </span>
                      </div>
                    )}
                  </div>
                </button>
                {isDraggable && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 -translate-y-1/2 end-1.5 text-muted-foreground/50 opacity-0 transition-opacity group-hover/acct:opacity-100"
                  >
                    <GripVertical className="w-4 h-4" />
                  </span>
                )}
                </div>
              );
            })}
            {waiting.map((wait) => (
              <button
                key={wait.account}
                type="button"
                role="menuitem"
                data-testid="account-needs-sign-in"
                className="w-full flex items-start gap-3 px-3 py-2.5 text-start transition-colors hover:bg-muted"
                onClick={() => {
                  setOpen(false);
                  router.push(`/login?mode=add-account&username=${encodeURIComponent(wait.username)}` as never);
                }}
              >
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-destructive" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate">{toUnicodeEmail(wait.label)}</span>
                  <span className="block text-xs text-foreground">{tWipe("needs_sign_in")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {wait.unsent
                      ? tWipe("switcher_waiting", { count: wait.unsent, date: waitDate(wait.until) })
                      : tWipe("switcher_kept", { date: waitDate(wait.until) })}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* Mountain View: the account actions as rows closing the white card,
              then "Manage your account" and the storage in use as pills under it. */}
          {mvPopover && (
            <>
              <div className="rounded-b-3xl bg-background border-t border-border/60 py-1" data-mv-account-actions="">
                {accounts.length < getMaxAccounts() && (
                  <button
                    onClick={handleAddAccount}
                    data-testid="add-account"
                    className="w-full flex items-center gap-4 px-5 py-3 text-sm text-start hover:bg-muted transition-colors"
                    role="menuitem"
                  >
                    <Plus className="w-5 h-5 text-muted-foreground" />
                    {t("mv_add_another_account")}
                  </button>
                )}
                {activeAccount && !activeAccount.isDefault && accounts.length > 1 && (
                  <button
                    onClick={() => handleSetDefault(activeAccount.id)}
                    className="w-full flex items-center gap-4 px-5 py-3 text-sm text-start hover:bg-muted transition-colors"
                    role="menuitem"
                  >
                    <Star className="w-5 h-5 text-muted-foreground" />
                    {t("set_as_default")}
                  </button>
                )}
                {accounts.length > 1 && (
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-4 px-5 py-3 text-sm text-start hover:bg-muted transition-colors"
                    role="menuitem"
                  >
                    <LogOut className="w-5 h-5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{t("sign_out_of", { account: displayEmail })}</span>
                  </button>
                )}
                <button
                  onClick={accounts.length > 1 ? handleLogoutAll : handleLogout}
                  className="w-full flex items-center gap-4 px-5 py-3 text-sm text-start hover:bg-muted transition-colors"
                  role="menuitem"
                >
                  <LogOut className="w-5 h-5 text-muted-foreground" />
                  {accounts.length > 1 ? t("sign_out_all") : t("sign_out")}
                </button>
              </div>
              <button
                type="button"
                onClick={() => { setOpen(false); router.push("/settings" as never); }}
                className="mt-2 w-full flex items-center gap-4 rounded-full bg-background px-5 py-3 text-sm text-start hover:bg-muted transition-colors"
                role="menuitem"
                data-mv-manage-account=""
              >
                <Settings className="w-5 h-5 text-muted-foreground" />
                {t("mv_manage_account")}
              </button>
              {quota && quota.total > 0 && (
                <div className="mt-2 flex items-center gap-4 rounded-full bg-background px-5 py-3 text-sm" data-mv-storage="">
                  <Cloud className="w-5 h-5 text-muted-foreground" />
                  {t("mv_storage_used", {
                    percent: Math.min(100, Math.round((quota.used / quota.total) * 100)),
                    total: formatFileSize(quota.total),
                  })}
                </div>
              )}
              <HelpMenuItems
                onSelect={() => setOpen(false)}
                className="mt-2 rounded-3xl bg-background py-1"
                itemClassName="w-full flex items-center gap-4 px-5 py-3 text-sm text-start hover:bg-muted transition-colors"
                iconClassName="w-5 h-5 shrink-0 text-muted-foreground"
              />
            </>
          )}

          {/* Separator + Add Account */}
          {!mvPopover && accounts.length < getMaxAccounts() && (
            <div className="border-t border-border">
              <button
                onClick={handleAddAccount}
                data-testid="add-account"
                className="w-full flex items-center gap-2 px-3 py-2 pointer-coarse:min-h-11 text-sm text-start text-foreground hover:bg-muted transition-colors"
                role="menuitem"
              >
                <Plus className="w-4 h-4" />
                {t("add_account")}
              </button>
            </div>
          )}

          {!mvPopover && (
            <div className={cn(accounts.length >= getMaxAccounts() && "border-t border-border")}>
              <button
                onClick={handleManageAccounts}
                data-testid="manage-accounts"
                className="w-full flex items-center gap-2 px-3 py-2 pointer-coarse:min-h-11 text-sm text-start text-foreground hover:bg-muted transition-colors"
                role="menuitem"
              >
                <Settings className="w-4 h-4" />
                {tFolders("manage_accounts")}
              </button>
            </div>
          )}

          {/* Accessibility and help links the operator set (lib/help-links.ts). */}
          {!mvPopover && (
            <HelpMenuItems
              onSelect={() => setOpen(false)}
              className="border-t border-border py-1"
              itemClassName="w-full flex items-center gap-2 px-3 py-2 pointer-coarse:min-h-11 text-sm text-start text-foreground hover:bg-muted transition-colors"
            />
          )}

          {/* Separator + Actions. Under Mountain View a single login signs out
              from the pill above, so these rows are only for picking among several. */}
          <div className={cn("border-t border-border", mvPopover && "hidden")}>
            {activeAccount && !activeAccount.isDefault && accounts.length > 1 && (
              <button
                onClick={() => handleSetDefault(activeAccount.id)}
                className={cn("w-full flex items-center gap-2 py-2 pointer-coarse:min-h-11 text-sm text-start text-foreground hover:bg-muted transition-colors", mvPopover ? "px-4" : "px-3")}
                role="menuitem"
              >
                <Star className="w-4 h-4" />
                {t("set_as_default")}
              </button>
            )}
            <button
              onClick={handleLogout}
              className={cn("w-full flex items-center gap-2 py-2 pointer-coarse:min-h-11 text-sm text-start text-foreground hover:bg-muted transition-colors", mvPopover ? "px-4" : "px-3")}
              role="menuitem"
            >
              <LogOut className="w-4 h-4" />
              {t("sign_out_of", { account: displayEmail })}
            </button>
            {!mvPopover && accounts.length > 1 && (
              <button
                onClick={handleLogoutAll}
                className="w-full flex items-center gap-2 px-3 py-2 pointer-coarse:min-h-11 text-sm text-start text-foreground hover:bg-muted transition-colors"
                role="menuitem"
              >
                <LogOut className="w-4 h-4" />
                {t("sign_out_all")}
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
