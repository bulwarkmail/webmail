"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FilePen, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { editForbidden, followEditSessions, getEditBridge, parkFilesForReply, parseEditSource, readEditedFile, useEditSessions } from "@/lib/desktop/edit-attachments";
import { openMailLink } from "@/lib/desktop/mail-links";
import type { DesktopEditSession } from "@/lib/desktop/types";
import { saveBlobAs } from "@/lib/download-guard";
import { handOffDraft } from "@/lib/launch-handoff";
import { useAccountSubjects } from "@/lib/org/account-subjects";
import { openDraftWindow } from "@/lib/popout/open";
import { addSignOutGate } from "@/lib/sign-out-cleanup";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";

function useSignedInAccounts(): Set<string> {
  const accounts = useAccountStore((s) => s.accounts);
  const active = useAuthStore((s) => s.activeAccountId);
  return useMemo(() => new Set([...accounts.map((a) => a.id), ...(active ? [active] : [])]), [accounts, active]);
}

/**
 * Attachments opened with Edit and saved in their program, with what can be done with them.
 * A composer offers its own files on the chip, so this has what no composer holds. It stays
 * until the user has decided: a save may come at any time, also while the app was closed.
 * Only for accounts signed in here: someone else signing in doesn't see these.
 * Main window only, and nothing at all in a browser.
 */
export function EditedFilesHost() {
  const t = useTranslations("desktopEdit");
  const router = useRouter();
  const tRef = useRef(t);
  tRef.current = t;
  const sessions = useEditSessions((s) => s.sessions);
  const accounts = useSignedInAccounts();
  const [busy, setBusy] = useState<string | null>(null);
  const available = !!getEditBridge();

  useEffect(() => {
    if (available) followEditSessions();
  }, [available]);

  const offers = useMemo(() => sessions.filter((s) => s.changed && !s.claimed && accounts.has(s.account)), [sessions, accounts]);

  // Whoever is in the other program sees this. Once per file, not at every save.
  const toldRef = useRef(new Set<string>());
  useEffect(() => {
    const os = getDesktopBridge()?.os;
    for (const session of offers) {
      if (toldRef.current.has(session.id)) continue;
      toldRef.current.add(session.id);
      void os?.notify({
        id: `edit-${session.id}`,
        title: tRef.current("changed_title", { name: session.name }),
        body: tRef.current("changed_body"),
        context: JSON.stringify({ editedFile: true }),
      }).catch(() => {});
    }
  }, [offers]);

  // The organisation's no ends a session, also one with a file open and edits in it.
  useEffect(() => {
    const bridge = getEditBridge();
    if (!bridge) return;
    const enforce = () => {
      for (const session of useEditSessions.getState().sessions) {
        if (!editForbidden(session.account)) continue;
        void bridge.discard(session.id);
        toast.error(tRef.current("removed_policy", { name: session.name }));
      }
    };
    enforce();
    const stops = [usePolicyStore.subscribe(enforce), useAccountSubjects.subscribe(enforce), useEditSessions.subscribe(enforce)];
    return () => stops.forEach((stop) => stop());
  }, []);

  // Edits nobody took: asks before a sign-out the user started. A wipe doesn't.
  useEffect(() => {
    if (!getEditBridge()) return;
    return addSignOutGate(async (accountId) => {
      const waiting = useEditSessions.getState().sessions.filter((s) => s.account === accountId && s.changed);
      const dialogs = getDesktopBridge()?.dialogs;
      if (waiting.length === 0 || !dialogs) return true;
      const buttons = [tRef.current("signout_confirm"), tRef.current("cancel")];
      const choice = await dialogs.confirm({
        type: "warning",
        message: tRef.current("signout_title"),
        detail: tRef.current("signout_detail"),
        buttons,
        defaultId: 1,
      });
      return choice === 0;
    });
  }, []);

  if (!available || offers.length === 0) return null;

  const withFile = async (session: DesktopEditSession, then: (file: File, hash: string) => void) => {
    setBusy(session.id);
    try {
      const outcome = await readEditedFile(session);
      if (outcome.ok) then(outcome.file, outcome.hash);
      else if (outcome.reason === "policy") toast.error(t("blocked_policy"));
      else if (outcome.reason === "busy") toast.error(t("read_busy", { name: session.name }));
      else if (outcome.reason !== "locked") toast.error(t("read_failed", { name: session.name }));
    } catch (error) {
      console.error("Could not read an edited file:", error);
      toast.error(t("read_failed", { name: session.name }));
    } finally {
      setBusy(null);
    }
  };

  const attachToReply = (session: DesktopEditSession, emailId: string, ownerAccountId: string | undefined) => withFile(session, (file) => {
    parkFilesForReply(emailId, [file]);
    const slot = useAccountStore.getState().accounts.find((a) => a.id === session.account)?.cookieSlot;
    openMailLink(
      { kind: "message", id: emailId, ...(slot !== undefined ? { slot } : {}), ownerAccountId, reply: true },
      { replyText: "" },
      (path) => router.push(path),
    );
  });

  const saveCopy = (session: DesktopEditSession) => withFile(session, (file, hash) => {
    if (saveBlobAs(file, file.name, { kind: "attachment", subject: session.account })) void getEditBridge()?.taken(session.id, hash);
  });

  const discard = async (session: DesktopEditSession) => {
    const bridge = getDesktopBridge();
    const choice = await bridge?.dialogs?.confirm({
      type: "warning",
      message: t("discard_title", { name: session.name }),
      detail: t("discard_detail"),
      buttons: [t("discard_confirm"), t("cancel")],
      defaultId: 1,
    });
    if (choice === 0) await getEditBridge()?.discard(session.id);
  };

  return (
    <section
      aria-label={t("offers_label")}
      data-testid="edited-files"
      // The toasts have the other corner, and one is up right when this appears. Over the sidebar (50), under dialogs (60).
      className="fixed bottom-4 start-[4.75rem] z-[55] flex max-h-[60vh] w-[22rem] max-w-[calc(100vw-6rem)] flex-col gap-2 overflow-y-auto"
    >
      {offers.map((session) => {
        const source = parseEditSource(session.source);
        return (
          <div key={session.id} data-testid="edited-file" className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg">
            <div className="flex items-start gap-2">
              <FilePen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-foreground" dir="auto">{t("changed_title", { name: session.name })}</p>
                <p className="text-xs text-muted-foreground">{t("changed_body")}</p>
              </div>
              <button
                type="button"
                onClick={() => void discard(session)}
                title={t("discard")}
                aria-label={`${t("discard")} ${session.name}`}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {source.kind === "mail" && (
                <Button size="sm" disabled={busy === session.id} onClick={() => void attachToReply(session, source.emailId, source.ownerAccountId)}>{t("reply")}</Button>
              )}
              {source.kind === "draft" && source.draftId && (
                <Button size="sm" onClick={() => openDraftWindow({ draftId: source.draftId as string, localAccountId: session.account, ownerAccountId: source.ownerAccountId })}>{t("open_draft")}</Button>
              )}
              {(source.kind === "file" || (source.kind === "draft" && !source.draftId)) && (
                <Button size="sm" disabled={busy === session.id} onClick={() => void withFile(session, (file) => handOffDraft({ files: [file] }))}>{t("new_message")}</Button>
              )}
              <Button size="sm" variant="outline" disabled={busy === session.id} onClick={() => void saveCopy(session)}>{t("save_copy")}</Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
