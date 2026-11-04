"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronDown } from "@/components/icons";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { sortDefaultFirst } from "@/lib/account-utils";
import { useDesktopPolicy } from "@/lib/desktop/policy";
import { accountRefusedByDesktopPolicy } from "@/lib/desktop/refused-accounts";
import { toUnicodeEmail } from "@/lib/idn";
import { cn } from "@/lib/utils";
import { useAccountStore, type AccountEntry } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";

const addressOf = (account: AccountEntry) => toUnicodeEmail(account.email || account.username);

/**
 * Which account a screen that shows one account at a time (Contacts, Files) is
 * showing, by its address, under the screen's title. A click lists the other
 * signed-in accounts by address and switches. Nothing with a single account.
 */
export function AccountScopeLabel({ className }: { className?: string }) {
  const t = useTranslations("ux_p2_pim_cm");
  const storedAccounts = useAccountStore((s) => s.accounts);
  const devicePolicy = useDesktopPolicy();
  const accounts = useMemo(
    () => sortDefaultFirst(devicePolicy.AllowedJmapServers.value ? storedAccounts.filter((account) => !accountRefusedByDesktopPolicy(account, devicePolicy)) : storedAccounts),
    [storedAccounts, devicePolicy],
  );
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const menu = useContextMenu<null>();

  const active = accounts.find((account) => account.id === activeAccountId);
  if (accounts.length < 2 || !active) return null;
  const address = addressOf(active);

  return (
    <>
      <button
        type="button"
        data-testid="account-scope"
        data-account-email={active.email || active.username}
        aria-haspopup="menu"
        aria-expanded={menu.contextMenu.isOpen}
        aria-label={t("account_scope_label", { address })}
        title={t("account_scope_label", { address })}
        onMouseDown={(e) => { if (menu.contextMenu.isOpen) e.stopPropagation(); }}
        onClick={(e) => {
          if (menu.contextMenu.isOpen) menu.closeContextMenu();
          else menu.openContextMenuFrom(e.currentTarget, null, "start");
        }}
        className={cn(
          "flex max-w-full min-w-0 items-center gap-0.5 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <span className="truncate" dir="ltr">{address}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      </button>
      <ContextMenu ref={menu.menuRef} isOpen={menu.contextMenu.isOpen} position={menu.contextMenu.position} onClose={menu.closeContextMenu} label={t("account_scope_menu")}>
        {accounts.map((account) => (
          <ContextMenuItem
            key={account.id}
            icon={account.id === active.id ? Check : undefined}
            label={addressOf(account)}
            testId="account-scope-option"
            disabled={account.id === active.id}
            onClick={() => {
              menu.closeContextMenu();
              void switchAccount(account.id);
            }}
          />
        ))}
      </ContextMenu>
    </>
  );
}
