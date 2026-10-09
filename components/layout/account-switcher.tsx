"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useId } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, LogOut, Mails, Star, ChevronDown, AlertCircle, GripVertical, X } from "@/components/icons";
import { useTranslations } from "next-intl";
import type { Mailbox } from "@/lib/jmap/types";
import { useAccountStore, type AccountEntry } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getMaxAccounts, sortDefaultFirst, reorderNonDefaultIds } from "@/lib/account-utils";
import { inboxUnread, totalInboxUnread } from "@/lib/account-inbox-unread";
import { isDocumentRTL } from "@/i18n/direction";
import { cn } from "@/lib/utils";
import { useRouter } from "@/i18n/navigation";
import { Avatar } from "@/components/ui/avatar";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { toUnicodeDomain, toUnicodeEmail } from "@/lib/idn";

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

function AccountAvatar({ account, size = "sm" }: { account: AccountEntry; size?: "sm" | "md" | "xl" }) {
  return (
    <Avatar
      name={account.displayName || account.label}
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
  const ownMailboxes = useEmailStore((s) => s.mailboxes);

  const accounts = useAccountStore((s) => s.accounts);
  const setDefaultAccount = useAccountStore((s) => s.setDefaultAccount);
  const reorderAccounts = useAccountStore((s) => s.reorderAccounts);
  // Read activeAccountId from authStore so the selector matches the actually-loaded
  // session (primaryIdentity, JMAP client). accountStore.activeAccountId is a separate
  // persisted copy that can drift out of sync across hydration / partial persist writes.
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const activeAccount = accounts.find((a) => a.id === activeAccountId);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const logout = useAuthStore((s) => s.logout);
  const removeAccount = useAuthStore((s) => s.removeAccount);
  const logoutAll = useAuthStore((s) => s.logoutAll);

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

  const handleRemove = (e: React.MouseEvent, account: AccountEntry) => {
    e.stopPropagation();
    const label = toUnicodeEmail(account.email || account.username);
    if (!window.confirm(t("remove_account_confirm", { account: label }))) return;
    removeAccount(account.id);
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
  const displayName = toUnicodeEmail(activeAccount?.displayName || activeAccount?.label || "");
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
  const unreadFor = (account: AccountEntry) =>
    mvPopover ? inboxUnread(unreadByAccount[account.id]) : undefined;
  const allInboxesUnread = totalInboxUnread(
    accounts.filter((account) => account.isConnected).map((account) => account.id),
    unreadByAccount
  );

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        data-testid="account-switcher"
        data-active-account-id={activeAccountId ?? undefined}
        className={cn(
          "flex items-center gap-2 rounded-md transition-colors",
          variant !== "expanded"
            ? "justify-center w-10 h-10 hover:bg-muted"
            : "w-full px-2 py-1.5 hover:bg-muted text-start min-w-0",
          className
        )}
        title={variant !== "expanded" ? (displayName || displayEmail) : undefined}
        aria-label={t("switch_account")}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
      >
        {activeAccount ? (
          <>
            <AccountAvatar account={activeAccount} size={variant === "expanded" ? "md" : "sm"} />
            {variant === "expanded" && (
              <>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
                  <p className="text-xs text-muted-foreground truncate">{displayEmail}</p>
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
            "border border-border bg-background text-foreground shadow-lg z-50 overflow-hidden",
            // Width and radius come from the layout's own tokens, keyed on the
            // attribute below; only the elevation differs in markup.
            mvPopover ? "shadow-xl" : "w-72 rounded-lg"
          )}
          data-mv-account-popover={mvPopover ? "" : undefined}
          role="menu"
          id={menuId}
          aria-label={t("switch_account")}
          onKeyDown={handleMenuKeyDown}
        >
          {mvPopover && activeAccount && (
            <div className="flex flex-col items-center gap-1 px-4 pt-6 pb-4 text-center">
              <AccountAvatar account={activeAccount} size="xl" />
              <p className="mt-2 text-base font-medium truncate max-w-full">{displayName}</p>
              <p className="text-sm text-muted-foreground truncate max-w-full">{displayEmail}</p>
            </div>
          )}

          {mvPopover && onSelectAllInboxes && (
            <div className="border-t border-border">
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
              mvPopover && "border-t border-border",
              mvPopover && listedAccounts.length === 0 && "hidden"
            )}
          >
            {listedAccounts.map((account) => {
              const isActive = account.id === activeAccountId;
              const isDraggable = !account.isDefault && accounts.length > 2;
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
                  data-testid="account-option"
                  data-account-id={account.id}
                  data-account-email={account.email || account.username}
                  className={cn(
                    "w-full flex items-start gap-3 px-3 py-2.5 text-start transition-colors",
                    isActive ? "bg-accent/50" : "hover:bg-muted",
                    (!isActive && !account.isDefault) ? (isDraggable ? "pe-14" : "pe-8") : (isDraggable && "pe-7")
                  )}
                  role="menuitem"
                  disabled={isActive}
                >
                  <div className="relative flex-shrink-0">
                    <AccountAvatar account={account} size="md" />
                    {isActive && (
                      <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-primary-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-sm font-medium truncate">
                        {toUnicodeEmail(account.displayName || account.label)}
                      </span>
                      {account.isDefault && (
                        <Star className="w-3 h-3 text-amber-500 flex-shrink-0 fill-amber-500" />
                      )}
                      <UnreadBadge count={unreadFor(account)} />
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {toUnicodeEmail(account.email || account.username)}
                    </p>
                    {/* Server and connection state: Mountain View keeps the line
                        only for an account in trouble. */}
                    <div className={cn("flex items-center gap-1 mt-0.5", mvPopover && !account.hasError && "hidden")}>
                      {account.hasError ? (
                        <AlertCircle className="w-3 h-3 text-destructive" />
                      ) : (
                        <span className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          account.isConnected ? "bg-green-500" : "bg-muted-foreground/40"
                        )} />
                      )}
                      <span className="text-[10px] text-muted-foreground truncate">
                        {(() => { try { return toUnicodeDomain(new URL(account.serverUrl).hostname); } catch { return account.serverUrl; } })()}
                      </span>
                    </div>
                  </div>
                </button>
                {isDraggable && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute end-7 top-1/2 -translate-y-1/2 text-muted-foreground/50 opacity-0 transition-opacity group-hover/acct:opacity-100"
                  >
                    <GripVertical className="w-4 h-4" />
                  </span>
                )}
                {!isActive && !account.isDefault && (
                  <button
                    type="button"
                    onClick={(e) => handleRemove(e, account)}
                    role="menuitem"
                    aria-label={t("remove_account")}
                    title={t("remove_account")}
                    className="absolute end-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground/60 opacity-0 transition-opacity group-hover/acct:opacity-100 hover:bg-destructive/10 hover:text-destructive focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-destructive"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
                </div>
              );
            })}
          </div>

          {/* Mountain View: "Add another account" and "Sign out of all accounts" as two
              pills side by side; with a single login the second is plain "Sign out". */}
          {mvPopover && (
            <div className="flex flex-wrap items-center justify-center gap-2 border-t border-border px-4 py-3" data-mv-account-actions="">
              {accounts.length < getMaxAccounts() && (
                <button
                  onClick={handleAddAccount}
                  data-testid="add-account"
                  className="flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm hover:bg-muted transition-colors"
                  role="menuitem"
                >
                  <Plus className="w-4 h-4" />
                  {t("add_account")}
                </button>
              )}
              <button
                onClick={accounts.length > 1 ? handleLogoutAll : handleLogout}
                className="flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm hover:bg-muted transition-colors"
                role="menuitem"
              >
                <LogOut className="w-4 h-4" />
                {accounts.length > 1 ? t("sign_out_all") : t("sign_out")}
              </button>
            </div>
          )}

          {/* Separator + Add Account */}
          {!mvPopover && accounts.length < getMaxAccounts() && (
            <div className="border-t border-border">
              <button
                onClick={handleAddAccount}
                data-testid="add-account"
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                role="menuitem"
              >
                <Plus className="w-4 h-4" />
                {t("add_account")}
              </button>
            </div>
          )}

          {/* Separator + Actions. Under Mountain View a single login signs out
              from the pill above, so these rows are only for picking among several. */}
          <div className={cn("border-t border-border", mvPopover && accounts.length < 2 && "hidden")}>
            {activeAccount && !activeAccount.isDefault && accounts.length > 1 && (
              <button
                onClick={() => handleSetDefault(activeAccount.id)}
                className={cn("w-full flex items-center gap-2 py-2 text-sm text-foreground hover:bg-muted transition-colors", mvPopover ? "px-4" : "px-3")}
                role="menuitem"
              >
                <Star className="w-4 h-4" />
                {t("set_as_default")}
              </button>
            )}
            <button
              onClick={handleLogout}
              className={cn("w-full flex items-center gap-2 py-2 text-sm text-foreground hover:bg-muted transition-colors", mvPopover ? "px-4" : "px-3")}
              role="menuitem"
            >
              <LogOut className="w-4 h-4" />
              {t("sign_out_of", { account: displayEmail })}
            </button>
            {!mvPopover && accounts.length > 1 && (
              <button
                onClick={handleLogoutAll}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-muted transition-colors"
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
