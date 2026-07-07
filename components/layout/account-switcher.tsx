"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, LogOut, Star, ChevronDown, AlertCircle, GripVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAccountStore, type AccountEntry } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { getMaxAccounts, sortDefaultFirst, reorderNonDefaultIds } from "@/lib/account-utils";
import { cn } from "@/lib/utils";
import { useRouter } from "@/i18n/navigation";
import { Avatar } from "@/components/ui/avatar";

interface AccountSwitcherProps {
  /** "rail" = small avatar only (NavigationRail), "expanded" = avatar + name + email (Sidebar) */
  variant?: "rail" | "expanded";
  className?: string;
}

function AccountAvatar({ account, size = "sm" }: { account: AccountEntry; size?: "sm" | "md" }) {
  return (
    <Avatar
      name={account.displayName || account.label}
      email={account.email || account.username}
      size="sm"
      className={cn("flex-shrink-0", size === "md" && "w-9 h-9 text-sm")}
      disableFavicon
      fallbackColor={account.avatarColor}
    />
  );
}

export function AccountSwitcher({ variant = "rail", className }: AccountSwitcherProps) {
  const t = useTranslations("sidebar");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

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
  const logoutAll = useAuthStore((s) => s.logoutAll);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    if (variant === "rail") {
      setPopoverStyle({
        position: "fixed",
        left: rect.right + 8,
        bottom: Math.max(8, window.innerHeight - rect.bottom),
      });
    } else {
      setPopoverStyle({
        position: "fixed",
        left: rect.left,
        top: rect.bottom + 4,
      });
    }
  }, [variant]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
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
  }, [open, updatePosition]);

  const handleSwitch = async (accountId: string) => {
    if (accountId === activeAccountId) return;
    setOpen(false);
    await switchAccount(accountId);
  };

  const handleAddAccount = () => {
    setOpen(false);
    router.push(`/login?mode=add-account` as never);
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
  const displayName = activeAccount?.displayName || activeAccount?.label || "";
  const displayEmail = activeAccount?.email || activeAccount?.username || "";

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        data-testid="account-switcher"
        data-active-account-id={activeAccountId ?? undefined}
        className={cn(
          "flex items-center gap-2 rounded-md transition-colors",
          variant === "rail"
            ? "justify-center w-10 h-10 hover:bg-muted"
            : "w-full px-2 py-1.5 hover:bg-muted text-start min-w-0",
          className
        )}
        title={variant === "rail" ? (displayName || displayEmail) : undefined}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {activeAccount ? (
          <>
            <AccountAvatar account={activeAccount} size={variant === "rail" ? "sm" : "md"} />
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
            variant === "rail" ? "w-8 h-8 text-xs" : "w-9 h-9 text-sm"
          )}>
            ?
          </div>
        )}
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          style={popoverStyle}
          className="w-72 rounded-lg border border-border bg-background text-foreground shadow-lg z-50 overflow-hidden"
          role="menu"
        >
          {/* Account List */}
          <div className="py-1 max-h-64 overflow-y-auto">
            {displayAccounts.map((account) => {
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
                    isDraggable && "pe-7"
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
                        {account.displayName || account.label}
                      </span>
                      {account.isDefault && (
                        <Star className="w-3 h-3 text-amber-500 flex-shrink-0 fill-amber-500" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {account.email || account.username}
                    </p>
                    <div className="flex items-center gap-1 mt-0.5">
                      {account.hasError ? (
                        <AlertCircle className="w-3 h-3 text-destructive" />
                      ) : (
                        <span className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          account.isConnected ? "bg-green-500" : "bg-muted-foreground/40"
                        )} />
                      )}
                      <span className="text-[10px] text-muted-foreground truncate">
                        {(() => { try { return new URL(account.serverUrl).hostname; } catch { return account.serverUrl; } })()}
                      </span>
                    </div>
                  </div>
                </button>
                {isDraggable && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 opacity-0 transition-opacity group-hover/acct:opacity-100"
                  >
                    <GripVertical className="w-4 h-4" />
                  </span>
                )}
                </div>
              );
            })}
          </div>

          {/* Separator + Add Account */}
          {accounts.length < getMaxAccounts() && (
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

          {/* Separator + Actions */}
          <div className="border-t border-border">
            {activeAccount && !activeAccount.isDefault && accounts.length > 1 && (
              <button
                onClick={() => handleSetDefault(activeAccount.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                role="menuitem"
              >
                <Star className="w-4 h-4" />
                {t("set_as_default")}
              </button>
            )}
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              role="menuitem"
            >
              <LogOut className="w-4 h-4" />
              {t("sign_out_of", { account: displayEmail })}
            </button>
            {accounts.length > 1 && (
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
