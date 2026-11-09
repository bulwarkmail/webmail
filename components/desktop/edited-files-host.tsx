"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FilePen, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useRouter } from "@/i18n/navigation";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { editForbidden, followEditSessions, getEditBridge, parkFilesForReply, parseEditSource, readEditedFile, useEditSessions } from "@/lib/desktop/edit-attachments";
import { filesClientFor, refreshFilesFor, saveBackToNode, saveBesideNode, type NodeEditSource } from "@/lib/desktop/save-to-files";
import { openMailLink } from "@/lib/desktop/mail-links";
import { contentHiddenFor } from "@/lib/desktop/mail-notifications";
import type { DesktopEditSession } from "@/lib/desktop/types";
import { saveBlobAs } from "@/lib/download-guard";
import { findTrashFolder, trashSubtreeIds } from "@/lib/files-trash";
import { handOffDraft } from "@/lib/launch-handoff";
import { useAccountSubjects } from "@/lib/org/account-subjects";
import { openDraftWindow } from "@/lib/popout/open";
import { addSignOutGate } from "@/lib/sign-out-cleanup";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useFileStore } from "@/stores/file-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";

function useSignedInAccounts(): Set<string> {
  const accounts = useAccountStore((s) => s.accounts);
  const active = useAuthStore((s) => s.activeAccountId);
  return useMemo(() => new Set([...accounts.map((a) => a.id), ...(active ? [active] : [])]), [accounts, active]);
}

/** A file from Files whose saves go back on their own, as the user chose once (pim-p3-6). */
function autoNodeOf(session: DesktopEditSession): NodeEditSource | null {
  const source = parseEditSource(session.source);
  return source.kind === "node" && source.auto ? source : null;
}

/**
 * Attachments and files from Files opened in their own program and saved there, with what
 * can be done with them. A composer offers its own files on the chip, so this has what no
 * composer holds. It stays until the user has decided: a save may come at any time, also
 * while the app was closed. Names only for accounts signed in here: someone else signing in
 * doesn't see these, and hears only that a copy is still held somewhere. Main window only,
 * nothing in a browser.
 *
 * A file from Files asks once: after Save to Files, each later save from its program goes
 * back by itself with a quiet toast, as OneDrive or Nextcloud do. Its card comes back only
 * for a real conflict (someone else changed it, or it went).
 */
export function EditedFilesHost() {
  const t = useTranslations("desktopEdit");
  const tFiles = useTranslations("ux_p2_pim_files");
  const tP3 = useTranslations("ux_p3_pim_files");
  const router = useRouter();
  // A file from Files that changed on the server, or went, since it was opened: what to do is asked on its card.
  const [conflicts, setConflicts] = useState<Record<string, "changed" | "gone">>({});
  // Hidden cards, by the version they were hidden at: the next save from the program shows them again.
  const [hidden, setHidden] = useState<Record<string, number>>({});
  // Files deleted in Files while their program had them, by the version then.
  const [deleted, setDeleted] = useState<Record<string, number>>({});
  const tRef = useRef(t);
  tRef.current = t;
  const sessions = useEditSessions((s) => s.sessions);
  const accounts = useSignedInAccounts();
  const accountList = useAccountStore((s) => s.accounts);
  const [busy, setBusy] = useState<string | null>(null);
  const available = !!getEditBridge();
  const { dialogProps, confirm } = useConfirmDialog();

  useEffect(() => {
    if (available) followEditSessions();
  }, [available]);

  const offers = useMemo(() => sessions.filter((s) => s.changed && !s.claimed && !s.held && accounts.has(s.account)), [sessions, accounts]);
  const held = useMemo(() => sessions.filter((s) => s.held), [sessions]);
  const heldNames = held.filter((s) => accounts.has(s.account)).map((s) => s.name);
  const heldOthers = held.length - heldNames.length;
  // One card per file, only where something is to be decided.
  const cards = useMemo(() => offers.filter((s) => {
    if (autoNodeOf(s) && !conflicts[s.id] && !s.lastChance) return false;
    if (!s.lastChance && ((hidden[s.id] ?? -1) >= s.version || (deleted[s.id] ?? -1) >= s.version)) return false;
    return true;
  }), [offers, conflicts, hidden, deleted]);

  // Whoever is in the other program sees this. Once per file, not at every save, and not for
  // a file that goes back to Files by itself. A file's name can say as much as a subject, so
  // the same rule as for new mail.
  const toldRef = useRef(new Set<string>());
  useEffect(() => {
    const os = getDesktopBridge()?.os;
    for (const session of cards) {
      if (toldRef.current.has(session.id)) continue;
      toldRef.current.add(session.id);
      void os?.notify({
        id: `edit-${session.id}`,
        title: contentHiddenFor(session.account) ? tRef.current("changed_title_hidden") : tRef.current("changed_title", { name: session.name }),
        body: tRef.current("changed_body"),
        context: JSON.stringify({ editedFile: true }),
      }).catch(() => {});
    }
  }, [cards]);

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

  /**
   * Save to Files (pim-p2-1): back into the node it came from, unless that changed on the
   * server meanwhile; then the card asks Keep both or Replace. `how`: "check" first,
   * "replace" over a change, "beside" as a new file next to it. From then on the file's
   * saves go back by themselves (pim-p3-6); `auto` is such a save.
   */
  const saveToFiles = (session: DesktopEditSession, source: NodeEditSource, how: "check" | "replace" | "beside", auto = false) => withFile(session, async (file, hash) => {
    const client = filesClientFor(session.account);
    const bridge = getEditBridge();
    if (!client || !bridge) {
      toast.error(tFiles("save_failed", { name: session.name }));
      return;
    }
    try {
      if (how === "beside") {
        const saved = await saveBesideNode(client, source, file);
        bridge.setSource(session.id, JSON.stringify({ ...saved.source, auto: true }));
        await bridge.taken(session.id, hash);
        toast.success(tFiles("saved_copy", { name: saved.name }));
      } else {
        const result = deleted[session.id] !== undefined ? { status: "gone" as const } : await saveBackToNode(client, source, file, how === "replace");
        if (result.status !== "saved") {
          setConflicts((all) => ({ ...all, [session.id]: result.status }));
          return;
        }
        bridge.setSource(session.id, JSON.stringify({ ...result.source, auto: true }));
        await bridge.taken(session.id, hash);
        // The first time, say that the next saves go there by themselves.
        toast.success(auto || source.auto ? tFiles("saved", { name: session.name }) : tP3("saved_auto", { name: session.name }));
      }
      setConflicts(({ [session.id]: _done, ...rest }) => rest);
      setDeleted(({ [session.id]: _done, ...rest }) => rest);
      refreshFilesFor(client);
    } catch (error) {
      console.error("Could not save an edited file to Files:", error);
      toast.error(tFiles("save_failed", { name: session.name }));
    }
  });
  const saveToFilesRef = useRef(saveToFiles);
  saveToFilesRef.current = saveToFiles;

  // Each new save of a file the user sent to Files once goes back by itself (pim-p3-6).
  // One version once: a conflict waits on its card for the user.
  const autoTried = useRef(new Map<string, number>());
  useEffect(() => {
    if (busy) return;
    for (const session of offers) {
      const node = autoNodeOf(session);
      if (!node || conflicts[session.id] || autoTried.current.get(session.id) === session.version) continue;
      autoTried.current.set(session.id, session.version);
      void saveToFilesRef.current(session, node, "check", true);
      return;
    }
  }, [offers, conflicts, busy]);

  // A file deleted in Files (to its trash or for good) takes its card with it. A later save
  // from its program asks again, with Save as a new file.
  const fileListing = useFileStore((s) => s.resources);
  const trashCount = useFileStore((s) => s.trashCount);
  const nodeCards = useMemo(() => cards.filter((s) => parseEditSource(s.source).kind === "node"), [cards]);
  useEffect(() => {
    if (nodeCards.length === 0) return;
    let stale = false;
    const byAccount = new Map<string, DesktopEditSession[]>();
    for (const session of nodeCards) byAccount.set(session.account, [...(byAccount.get(session.account) ?? []), session]);
    for (const [account, list] of byAccount) {
      const client = filesClientFor(account);
      if (!client) continue;
      void client.listAllFileNodes().then((nodes) => {
        if (stale) return;
        const ids = new Set(nodes.map((n) => n.id));
        const inTrash = trashSubtreeIds(nodes, findTrashFolder(nodes)?.id);
        const gone = list.filter((session) => {
          const source = parseEditSource(session.source);
          // A shared drive's node ("account:id") isn't in this list.
          return source.kind === "node" && !source.nodeId.includes(":") && (!ids.has(source.nodeId) || inTrash.has(source.nodeId));
        });
        if (gone.length === 0) return;
        setDeleted((all) => ({ ...all, ...Object.fromEntries(gone.map((s) => [s.id, s.version])) }));
        setConflicts((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !gone.some((s) => s.id === id))));
      }).catch(() => {});
    }
    return () => { stale = true; };
  }, [nodeCards, fileListing, trashCount]);

  if (!available || (cards.length === 0 && held.length === 0)) return <ConfirmDialog {...dialogProps} />;

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

  /** Until the program saves again. */
  const hide = (session: DesktopEditSession) => {
    setHidden((all) => ({ ...all, [session.id]: session.version }));
    setConflicts(({ [session.id]: _gone, ...rest }) => rest);
  };

  /**
   * The app's own question (in the desktop app the Bulwark question window), not the OS's
   * message box, with words for where the file came from. Its yes is the question main
   * would ask, so main deletes without asking again.
   */
  const discard = async (session: DesktopEditSession) => {
    const bridge = getEditBridge();
    if (!bridge) return;
    const fromFiles = parseEditSource(session.source).kind === "node";
    const yes = await confirm({
      title: t("discard_title", { name: session.name }),
      message: fromFiles ? tP3("discard_detail_file") : `${t("discard_detail")} ${t("outside_note")}`,
      confirmText: t("discard_confirm"),
      cancelText: t("cancel"),
      variant: "destructive",
    });
    if (!yes) return;
    await bridge.forceDiscard(session.id);
  };

  const accountLabel = (session: DesktopEditSession) => {
    if (accountList.length < 2) return null;
    const entry = accountList.find((a) => a.id === session.account);
    return entry?.label || entry?.username || null;
  };

  return (
    <>
    <section
      aria-label={tP3("offers_label")}
      data-testid="edited-files"
      // The toast corner, one card per file, with toasts stacked above it (data-toast-avoid):
      // never over the middle of a list (pim-p3-6).
      data-toast-avoid="bottom"
      className="fixed bottom-4 end-4 z-40 flex max-h-[60vh] w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto"
    >
      {held.length > 0 && (
        <div data-testid="edited-file-held" role="status" className="flex flex-col gap-1 rounded-lg border border-border bg-background p-3 text-xs shadow-lg">
          {heldNames.length > 0 && <p className="break-words text-foreground" dir="auto">{t("held_named", { names: heldNames.join(", ") })}</p>}
          {heldOthers > 0 && <p className="text-foreground">{t("held_unnamed")}</p>}
          <p className="text-muted-foreground">{t("outside_note")}</p>
        </div>
      )}
      {cards.map((session) => {
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
                {!conflict && <p className="text-xs text-muted-foreground">{t("changed_body")}</p>}
                {session.lastChance && <p className="text-xs font-medium text-foreground" data-testid="edited-file-last-chance">{t("last_chance")}</p>}
                {conflict && (
                  <p className="text-xs font-medium text-foreground" role="alert" data-testid="edited-file-conflict">
                    {conflict === "changed" ? tFiles("changed_on_server", { name: session.name }) : tFiles("gone_on_server", { name: session.name })}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => hide(session)}
                title={tP3("hide")}
                aria-label={`${tP3("hide")} ${session.name}`}
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
                <Button size="sm" variant="ghost" disabled={busy === session.id} onClick={() => hide(session)}>{tFiles("cancel")}</Button>
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
              <Button size="sm" variant="ghost" disabled={busy === session.id} onClick={() => void discard(session)} aria-label={`${t("discard")} ${session.name}`}>{t("discard")}</Button>
            </div>
            )}
          </div>
        );
      })}
    </section>
    <ConfirmDialog {...dialogProps} />
    </>
  );
}
