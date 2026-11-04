"use client";

import { Loader2, X } from "@/components/icons";
import { useTranslations } from "next-intl";
import type { ParsedMailto } from "@/lib/protocol-handlers/mailto";
import type { ParsedWebcal } from "@/lib/protocol-handlers/webcal";
import type { AccountEntry } from "@/stores/account-store";
import { cn } from "@/lib/utils";
import { accountRowText } from "@/lib/account-utils";
import { Avatar } from "@/components/ui/avatar";
import { useId } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";

type ProtocolAccountPickerProps = {
  accounts: AccountEntry[];
  activeAccountId: string | null;
  isSwitching?: boolean;
  onSelect: (accountId: string) => void;
  onCancel: () => void;
} & (
  | { kind: "mailto"; operation?: ParsedMailto }
  | { kind: "webcal"; operation?: ParsedWebcal }
);

function getHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

export function ProtocolAccountPicker({
  kind,
  accounts,
  activeAccountId,
  isSwitching = false,
  onSelect,
  onCancel,
  operation,
}: ProtocolAccountPickerProps) {
  const t = useTranslations("protocol_handlers");
  const tCommon = useTranslations("common");
  const details = operation
    ? kind === "mailto"
      ? [
          { label: t("detail_to"), value: operation.to.join(", ") || "-" },
          { label: t("detail_subject"), value: operation.subject || t("detail_no_subject") },
        ]
      : [
          { label: t("detail_calendar"), value: operation.suggestedName },
          { label: t("detail_source"), value: getHost(operation.subscriptionUrl) },
        ]
    : [];

  // A modal: the focus starts on the account in use (else the first one),
  // Tab stays inside, Escape cancels unless a switch is under way, and the
  // focus goes back to where it was.
  const titleId = useId();
  const panelRef = useFocusTrap({
    isActive: true,
    onEscape: () => { if (!isSwitching) onCancel(); },
    restoreFocus: true,
    initialFocus: () =>
      panelRef.current?.querySelector<HTMLElement>('[data-active-account="true"]')
      ?? panelRef.current?.querySelector<HTMLElement>('[data-account-option]'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onCancel} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md rounded-lg border border-border bg-background shadow-xl animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-foreground">{t("select_account_title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {kind === "mailto" ? t("select_mailto_account") : t("select_webcal_account")}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={tCommon("close")}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {details.length > 0 && (
          <div className="border-b border-border bg-muted/40 px-5 py-3">
            <dl className="space-y-1.5 text-sm">
              {details.map((detail) => (
                <div key={detail.label} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
                  <dt className="text-xs font-medium text-muted-foreground">{detail.label}</dt>
                  <dd className="truncate text-foreground" title={detail.value}>{detail.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div className="max-h-80 overflow-y-auto p-2">
          {accounts.map((account) => {
            const isActive = account.id === activeAccountId;
            const text = accountRowText(account, accounts);
            let host = account.serverUrl;
            try {
              host = new URL(account.serverUrl).hostname;
            } catch {
              // Keep the configured value when it is not an absolute URL.
            }

            return (
              <button
                key={account.id}
                type="button"
                data-account-option=""
                data-active-account={isActive || undefined}
                aria-current={isActive || undefined}
                disabled={isSwitching}
                onClick={() => onSelect(account.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-start transition-colors",
                  isActive ? "bg-accent/50" : "hover:bg-muted",
                  isSwitching && "cursor-wait opacity-70"
                )}
              >
                <Avatar
                  name={account.displayName || account.label}
                  email={account.email || account.username}
                  size="md"
                  className="shrink-0"
                  disableFavicon
                  fallbackColor={account.avatarColor}
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {text.title}
                    </span>
                    {isActive && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[0.625rem] font-medium text-primary">
                        {t("active_account")}
                      </span>
                    )}
                  </div>
                  {text.subtitle && <p className="truncate text-xs text-muted-foreground">{text.subtitle}</p>}
                  <p className="truncate text-[0.625rem] text-muted-foreground">{host}</p>
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          {isSwitching ? (
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("switching_account")}
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onCancel}
            disabled={isSwitching}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {tCommon("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
