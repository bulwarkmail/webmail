"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FilePen, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { editForbidden, followEditSessions, getEditBridge, parkFilesForReply, parseEditSource, readEditedFile, useEditSessions } from "@/lib/desktop/edit-attachments";
import { filesClientFor, refreshFilesFor, saveBackToNode, saveBesideNode, type NodeEditSource } from "@/lib/desktop/save-to-files";
import { openMailLink } from "@/lib/desktop/mail-links";
import { contentHiddenFor } from "@/lib/desktop/mail-notifications";
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
 * Names only for accounts signed in here: someone else signing in doesn't see these, and
 * hears only that a copy is still held somewhere. Main window only, nothing in a browser.
 */
export function EditedFilesHost() {
  const t = useTranslations("desktopEdit");
  const tFiles = useTranslations("ux_p2_pim_files");
  const router = useRouter();
  // A file from Files that changed on the server, or went, since it was opened: what to do is asked on its card.
  const [conflicts, setConflicts] = useState<Record<string, "changed" | "gone">>({});
  const tRef = useRef(t);
  tRef.current = t;
  const sessions = useEditSessions((s) => s.sessions);
  const accounts = useSignedInAccounts();
  const accountList = useAccountStore((s) => s.accounts);
  const [busy, setBusy] = useState<string | null>(null);
  const available = !!getEditBridge();

  useEffect(() => {
    if (available) followEditSessions();
  }, [available]);

  const offers = useMemo(() => sessions.filter((s) => s.changed && !s.claimed && !s.held && accounts.has(s.account)), [sessions, accounts]);
  const held = useMemo(() => sessions.filter((s) => s.held), [sessions]);
  const heldNames = held.filter((s) => accounts.has(s.account)).map((s) => s.name);
  const heldOthers = held.length - heldNames.length;

  // Whoever is in the other program sees this. Once per file, not at every save. A file's
  // name can say as much as a subject, so the same rule as for new mail.
  const toldRef = useRef(new Set<string>());
  useEffect(() => {
    const os = getDesktopBridge()?.os;
    for (const session of offers) {
      if (toldRef.current.has(session.id)) continue;
      toldRef.current.add(session.id);
      void os?.notify({
        id: `edit-${session.id}`,
        title: contentHiddenFor(session.account) ? tRef.current("changed_title_hidden") : tRef.current("changed_title", { name: session.name }),
        body: tRef.current("changed_body"),
        context: JSON.stringify({ editedFile: true }),
      }).catch(() => {});
    }
  }, [offers]);

  // Seen once, so a copy past its 30 days can go a day later.
  useEffect(() => {
    for (const session of offers) if (session.lastChance) getEditBridge()?.shown(session.id);
  }, [offers]);

  // The organisation's no ends a session, also one with a file open and edits in it. Someone
  // may be in the other program, so the OS says it as well, and the toast stays until read.
  useEffect(() => {
    const bridge = getEditBridge();
    if (!bridge) return;
    const enforce = () => {
      for (const session of useEditSessions.getState().sessions) {
        if (session.held || !editForbidden(session.account)) continue;
        void bridge.forceDiscard(session.id).then((result) => {
          if (result.refused) return;
          const message = tRef.current(result.held.length > 0 ? "removed_policy_held" : "removed_policy", { name: session.name });
          toast.error(message, { duration: 0 });
          void getDesktopBridge()?.os?.notify({
            id: `edit-policy-${session.id}`,
            title: contentHiddenFor(session.account) ? tRef.current("removed_policy_hidden") : message,
            body: tRef.current("outside_note"),
            context: JSON.stringify({ editedFile: true }),
          }).catch(() => {});
        });
      }
    };
    enforce();
    const stops = [usePolicyStore.subscribe(enforce), useAccountSubjects.subscribe(enforce), useEditSessions.subscribe(enforce)];
    return () => stops.forEach((stop) => stop());
  }, []);

  // Before a sign-out the user started. Main asks, as it's what would delete, and names what a
  // program still has open. A wipe doesn't ask.
  useEffect(() => {
    const bridge = getEditBridge();
    if (!bridge) return;
    return addSignOutGate((accountId) => bridge.askClear(accountId));
  }, []);

  if (!available || (offers.length === 0 && held.length === 0)) return null;

  const withFile = async (session: DesktopEditSession, then: (file: File, hash: string) => void | Promise<void>) => {
    setBusy(session.id);
    try {
      const outcome = await readEditedFile(session);
      if (outcome.ok) await then(outcome.file, outcome.hash);
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

  /** From the account the file belongs to, whichever one is on screen. */
  const attachToNew = (session: DesktopEditSession) => withFile(session, async (file) => {
    const auth = useAuthStore.getState();
    if (auth.activeAccountId !== session.account) await auth.switchAccount(session.account);
    handOffDraft({ files: [file] });
  });

  const saveCopy = (session: DesktopEditSession) => withFile(session, (file, hash) => {
    if (saveBlobAs(file, file.name, { kind: "attachment", subject: session.account })) void getEditBridge()?.taken(session.id, hash);
  });

  /**
   * Save to Files (pim-p2-1): back into the node it came from, unless that changed on the
   * server meanwhile; then the card asks Keep both or Replace. `how`: "check" first,
   * "replace" over a change, "beside" as a new file next to it.
   */
  const saveToFiles = (session: DesktopEditSession, source: NodeEditSource, how: "check" | "replace" | "beside") => withFile(session, async (file, hash) => {
    const client = filesClientFor(session.account);
    const bridge = getEditBridge();
    if (!client || !bridge) {
      toast.error(tFiles("save_failed", { name: session.name }));
      return;
    }
    try {
      if (how === "beside") {
        const saved = await saveBesideNode(client, source, file);
        bridge.setSource(session.id, JSON.stringify(saved.source));
        await bridge.taken(session.id, hash);
        toast.success(tFiles("saved_copy", { name: saved.name }));
      } else {
        const result = await saveBackToNode(client, source, file, how === "replace");
        if (result.status !== "saved") {
          setConflicts((all) => ({ ...all, [session.id]: result.status }));
          return;
        }
        bridge.setSource(session.id, JSON.stringify({ ...source, blobId: result.blobId }));
        await bridge.taken(session.id, hash);
        toast.success(tFiles("saved", { name: session.name }));
      }
      setConflicts(({ [session.id]: _done, ...rest }) => rest);
      refreshFilesFor(client);
    } catch (error) {
      console.error("Could not save an edited file to Files:", error);
      toast.error(tFiles("save_failed", { name: session.name }));
    }
  });

  const accountLabel = (session: DesktopEditSession) => {
    if (accountList.length < 2) return null;
    const entry = accountList.find((a) => a.id === session.account);
    return entry?.label || entry?.username || null;
  };

  return (
    <section
      aria-label={t("offers_label")}
      data-testid="edited-files"
      // Toasts have one corner and the account menu the other, and both have to stay reachable: over the mail columns, under any menu or dialog.
      className="fixed inset-x-0 bottom-4 z-40 mx-auto flex max-h-[60vh] w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto"
    >
      {held.length > 0 && (
        <div data-testid="edited-file-held" role="status" className="flex flex-col gap-1 rounded-lg border border-border bg-background p-3 text-xs shadow-lg">
          {heldNames.length > 0 && <p className="break-words text-foreground" dir="auto">{t("held_named", { names: heldNames.join(", ") })}</p>}
          {heldOthers > 0 && <p className="text-foreground">{t("held_unnamed")}</p>}
          <p className="text-muted-foreground">{t("outside_note")}</p>
        </div>
      )}
      {offers.map((session) => {
        const source = parseEditSource(session.source);
        const draftId = source.kind === "draft" && !session.savedAs ? source.draftId : null;
        const account = accountLabel(session);
        const node = source.kind === "node" ? source : null;
        const conflict = node ? conflicts[session.id] : undefined;
        return (
          <div key={session.id} data-testid="edited-file" className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg">
            <div className="flex items-start gap-2">
              <FilePen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-foreground" dir="auto">{t("changed_title", { name: session.name })}</p>
                {account && <p className="truncate text-xs text-muted-foreground" data-testid="edited-file-account">{account}</p>}
                <p className="text-xs text-muted-foreground">{t("changed_body")}</p>
                {session.lastChance && <p className="text-xs font-medium text-foreground" data-testid="edited-file-last-chance">{t("last_chance")}</p>}
                {conflict && (
                  <p className="text-xs font-medium text-foreground" role="alert" data-testid="edited-file-conflict">
                    {conflict === "changed" ? tFiles("changed_on_server", { name: session.name }) : tFiles("gone_on_server", { name: session.name })}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void getEditBridge()?.discard(session.id)}
                title={t("discard")}
                aria-label={`${t("discard")} ${session.name}`}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {node && conflict ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy === session.id} onClick={() => void saveToFiles(session, node, "beside")}>
                  {conflict === "changed" ? tFiles("keep_both") : tFiles("save_as_new")}
                </Button>
                {conflict === "changed" && (
                  <Button size="sm" variant="outline" disabled={busy === session.id} onClick={() => void saveToFiles(session, node, "replace")}>{tFiles("replace")}</Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy === session.id} onClick={() => setConflicts(({ [session.id]: _gone, ...rest }) => rest)}>{tFiles("cancel")}</Button>
              </div>
            ) : (
            <div className="flex flex-wrap gap-2">
              {node && (
                <Button size="sm" disabled={busy === session.id} onClick={() => void saveToFiles(session, node, "check")}>{tFiles("save_to_files")}</Button>
              )}
              {source.kind === "mail" && (
                <Button size="sm" disabled={busy === session.id} onClick={() => void attachToReply(session, source.emailId, source.ownerAccountId)}>{t("reply")}</Button>
              )}
              {draftId && (
                <Button size="sm" onClick={() => openDraftWindow({ draftId, localAccountId: session.account, ownerAccountId: source.kind === "draft" ? source.ownerAccountId : undefined })}>{t("open_draft")}</Button>
              )}
              {source.kind !== "mail" && !draftId && (
                <Button size="sm" variant={node ? "outline" : "default"} disabled={busy === session.id} onClick={() => void attachToNew(session)}>{t("new_message")}</Button>
              )}
              <Button size="sm" variant="outline" disabled={busy === session.id} onClick={() => void saveCopy(session)}>{t("save_copy")}</Button>
            </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
