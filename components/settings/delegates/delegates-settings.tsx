"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Loader2, UserPlus } from "@/components/icons";
import { SettingsSection } from "@/components/settings/settings-section";
import { useAuthStore } from "@/stores/auth-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";
import { useRestriction } from "@/hooks/use-restriction";
import { loadScopedPrincipalDirectory } from "@/lib/directory-scope";
import type { Principal, PrincipalListing } from "@/lib/jmap/types";
import type { ShareChangeResult, ShareTarget } from "@/lib/jmap/share-batch";
import type { ShareKind } from "@/lib/jmap/share-rights";
import {
  allowedLevels,
  buildRevokeChanges,
  changeStartFor,
  failedChanges,
  summarizeDelegates,
  type DelegateSummary,
} from "@/lib/delegation/delegation";
import { rememberPrincipals, rememberedPrincipals } from "@/lib/delegation/known-principals";
import { DelegateDialog, type DelegateDialogProps } from "./delegate-dialog";
import { principalDisplay } from "./principal-display";

type DialogState = { mode: "add" } | { mode: "change"; summary: DelegateSummary } | null;

/**
 * Settings > Sharing > Delegates: give someone access to mail, calendars
 * and contacts in one step, and see and take back who has access to what.
 * Hidden when the admin hides `delegation`; `sharingRights` limits the
 * rights offered. Calendars, contacts and files follow their feature gates.
 */
export function DelegatesSettings() {
  const t = useTranslations("delegates");
  const client = useAuthStore((s) => s.client);
  const accountKey = useAuthStore((s) => s.activeAccountId) ?? "";
  const delegation = useRestriction("delegation");
  const rights = useRestriction("sharingRights");
  const levels = useMemo(() => allowedLevels(rights.allowedValues), [rights.allowedValues]);
  const calendars = usePolicyStore((s) => s.isFeatureEnabled("calendarEnabled"));
  const contacts = usePolicyStore((s) => s.isFeatureEnabled("contactsEnabled"));
  const files = usePolicyStore((s) => s.isFeatureEnabled("filesEnabled"));
  const groupAddresses = usePolicyStore((s) => s.subject?.groups);

  const [targets, setTargets] = useState<ShareTarget[] | null>(null);
  const [failedKinds, setFailedKinds] = useState<ShareKind[]>([]);
  const [directory, setDirectory] = useState<PrincipalListing | null>(null);
  const [remembered, setRemembered] = useState<Map<string, Principal>>(() => new Map());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirmRemove, setConfirmRemove] = useState<DelegateSummary | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Each read is numbered; an answer that arrives after a newer read started
  // (another account, a changed gate) is dropped instead of shown.
  const readSeq = useRef(0);
  const reload = useCallback(async () => {
    if (!client?.getShareTargets) return;
    const seq = ++readSeq.current;
    const result = await client.getShareTargets({ calendars, contacts, files });
    if (seq !== readSeq.current) return;
    setTargets(result.targets);
    setFailedKinds(result.failed);
  }, [client, calendars, contacts, files]);

  useEffect(() => {
    if (!client || delegation.hidden) return;
    let cancelled = false;
    const reads = readSeq;
    setTargets(null);
    setFailedKinds([]);
    setDirectory(null);
    setRemembered(rememberedPrincipals(accountKey));
    void reload();
    void loadScopedPrincipalDirectory(client).then((listing) => {
      if (!cancelled) setDirectory(listing);
    });
    return () => {
      cancelled = true;
      reads.current++;
    };
  }, [client, accountKey, delegation.hidden, reload]);

  const ownIds = useMemo(() => (client ? [client.getAccountId()] : []), [client]);
  const ownEmails = useMemo(() => {
    const emails = new Set<string>();
    const username = client?.getUsername();
    if (username?.includes("@")) emails.add(username);
    for (const p of directory?.principals ?? []) if (ownIds.includes(p.id) && p.email) emails.add(p.email);
    return [...emails];
  }, [client, directory, ownIds]);
  const summaries = useMemo(() => (targets ? summarizeDelegates(targets, ownIds) : []), [targets, ownIds]);

  // Stalwart names a principal by its account id, and an account shared with
  // the user is in the session under the owner's address: a last way to name
  // someone the directory won't (Stalwart 1.0 with directory queries off).
  // The policy subject knows which of those accounts are groups.
  const sessionAccounts = useMemo(() => new Map((client?.getSharedAccounts() ?? []).map((a) => [a.id, a.name])), [client]);
  const principalFor = useCallback((id: string): Principal | null => {
    const known = directory?.principals.find((p) => p.id === id) ?? remembered.get(id);
    if (known) return known;
    const accountName = sessionAccounts.get(id);
    if (!accountName) return null;
    const isGroup = (groupAddresses ?? []).some((g) => g.toLowerCase() === accountName.toLowerCase());
    return { id, name: accountName, email: accountName.includes("@") ? accountName : null, type: isGroup ? "group" : "individual" };
  }, [directory, remembered, sessionAccounts, groupAddresses]);

  // Remember the names of the people who have access, so the list can name
  // them when the directory no longer does. Never the whole directory.
  useEffect(() => {
    if (!accountKey || summaries.length === 0 || !directory) return;
    const named = summaries
      .map((s) => directory.principals.find((p) => p.id === s.principalId))
      .filter((p): p is Principal => !!p);
    if (named.length > 0) rememberPrincipals(accountKey, named);
  }, [accountKey, summaries, directory]);

  if (delegation.hidden || !client) return null;

  // Change and Remove act on everything the person has; with a type unread,
  // that isn't known, so they wait until a read succeeds.
  const incomplete = failedKinds.length > 0;

  const onApplied: DelegateDialogProps["onApplied"] = (principal, results) => {
    rememberPrincipals(accountKey, [principal]);
    setRemembered(rememberedPrincipals(accountKey));
    const failed = failedChanges(results);
    if (failed.length === 0) {
      toast.success(dialog?.mode === "change" ? t("updated") : t("applied", { name: principalDisplay(principal).name }));
    }
    void reload();
  };

  const remove = async (summary: DelegateSummary) => {
    if (!targets || !client.applyShareChanges || incomplete) return;
    setRemovingId(summary.principalId);
    try {
      const results: ShareChangeResult[] = await client.applyShareChanges(buildRevokeChanges(targets, summary.principalId));
      const failed = failedChanges(results);
      if (failed.length === 0) toast.success(t("removed"));
      else toast.error(t("remove_partial", { items: failed.map((f) => f.change.name).join(", ") }));
      await reload();
    } finally {
      setRemovingId(null);
    }
  };

  const nameOf = (id: string) => {
    const principal = principalFor(id);
    return principal ? principalDisplay(principal).name : t("unknown_person");
  };

  return (
    <SettingsSection id="delegates" title={t("title")} description={t("description")} term="delegation">
      <div>
        <Button onClick={() => setDialog({ mode: "add" })} disabled={!targets} data-testid="delegates-give-access">
          <UserPlus className="me-2 h-4 w-4" />
          {t("give_access")}
        </Button>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("who_has_access")}</h4>
        {incomplete && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="status" data-testid="delegates-read-failed">
            <span>{t("read_failed")}</span>
            <Button variant="outline" size="sm" onClick={() => void reload()}>{t("retry")}</Button>
          </div>
        )}
        {targets === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</p>
        ) : summaries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("nobody")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="delegates-list">
            {summaries.map((summary) => {
              const principal = principalFor(summary.principalId);
              const display = principal ? principalDisplay(principal) : { name: t("unknown_person"), detail: summary.principalId };
              const busy = removingId === summary.principalId;
              return (
                <li key={summary.principalId} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center" data-testid="delegate-row">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar name={principal?.name} email={principal?.email ?? undefined} size="sm" className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 truncate text-sm font-medium">
                        <span className="truncate">{display.name}</span>
                        {principal?.type === "group" && (
                          <span className="rounded bg-muted px-1 py-0.5 text-[0.6875rem] font-normal text-muted-foreground">{t("group")}</span>
                        )}
                      </div>
                      {display.detail && <div className="truncate text-xs text-muted-foreground">{display.detail}</div>}
                      <div className="text-xs text-muted-foreground">{describeSummary(summary, t)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap shrink-0 gap-2 ps-11 sm:ps-0">
                    <Button variant="outline" size="sm" onClick={() => setDialog({ mode: "change", summary })} disabled={busy || incomplete}>
                      {t("change")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setConfirmRemove(summary)} disabled={busy || incomplete}>
                      {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                      {t("remove")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {dialog && targets && (
        <DelegateDialog
          client={client}
          targets={targets}
          directory={directory}
          ownIds={ownIds}
          ownEmails={ownEmails}
          existingIds={new Set(summaries.map((s) => s.principalId))}
          initial={dialog.mode === "change"
            ? {
                principal: principalFor(dialog.summary.principalId)
                  ?? { id: dialog.summary.principalId, name: t("unknown_person"), type: "individual" },
                ...changeStartFor(targets, dialog.summary.principalId, levels),
              }
            : undefined}
          levels={levels}
          levelsRestricted={rights.allowedValues !== null && levels.length < 2}
          seenSetsKeywords={client.sharesSeenWithKeywords?.() ?? false}
          onApplied={onApplied}
          onClose={() => setDialog(null)}
        />
      )}

      <ConfirmDialog
        isOpen={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => { if (confirmRemove) void remove(confirmRemove); }}
        title={confirmRemove ? t("remove_title", { name: nameOf(confirmRemove.principalId) }) : ""}
        message={confirmRemove ? t("remove_message", { name: nameOf(confirmRemove.principalId) }) : ""}
        confirmText={t("remove")}
        variant="destructive"
      />
    </SettingsSection>
  );
}

type Translate = ReturnType<typeof useTranslations<"delegates">>;

/** "All mail folders · 1 calendar · Read", in the order of the dialog. */
export function describeSummary(summary: DelegateSummary, t: Translate): string {
  const parts: string[] = [];
  const { mail, calendars, addressBooks, files } = summary;
  if (mail.shared > 0) {
    parts.push(mail.shared === mail.total
      ? t("summary.mail_all")
      : mail.shared === 1 && mail.inbox ? t("summary.mail_inbox") : t("summary.mail_some", { count: mail.shared }));
  }
  if (calendars.shared > 0) parts.push(t("summary.calendars", { count: calendars.shared }));
  if (addressBooks.shared > 0) parts.push(t("summary.address_books", { count: addressBooks.shared }));
  if (files > 0) parts.push(t("summary.files", { count: files }));
  parts.push(t(`level.${summary.level ?? "none"}`));
  return parts.join(" · ");
}
