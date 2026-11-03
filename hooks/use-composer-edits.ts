"use client";

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useTranslations } from "next-intl";
import { editFileInfo, followEditSessions, getEditBridge, parseEditSource, readEditedFile, takeFilesForReply, useEditSessions, type EditSource } from "@/lib/desktop/edit-attachments";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { useEditAttachment } from "@/hooks/use-edit-attachment";
import { toast } from "@/stores/toast-store";

/** What this needs from a composer's attachment. */
export interface EditableAttachment {
  file?: File;
  name: string;
  type: string;
  blobId?: string;
  uploading?: boolean;
  error?: boolean;
  /** The Edit session this chip's file belongs to. Kept through every state change of the chip. */
  editSessionId?: string;
}

interface Options<A extends EditableAttachment> {
  attachments: A[];
  setAttachments: Dispatch<SetStateAction<A[]>>;
  addFiles: (files: File[]) => Promise<void>;
  load: (attachment: A) => Promise<Blob>;
  /** The local account the draft goes through. */
  account: string;
  draftId: string | null;
  ownerAccountId?: string;
  /** The message a reply answers: a file waiting for that reply lands here. */
  repliesTo?: string;
  /** Only once the composer can upload. */
  ready: boolean;
}

/**
 * A composer's part of Edit: its chips start sessions and hold them, so the offer to update
 * sits on the chip rather than in the main window. A session goes when the draft is sent or
 * discarded, unless it has edits nobody took: those stay, for the user to decide on.
 */
export function useComposerEdits<A extends EditableAttachment>({ attachments, setAttachments, addFiles, load, account, draftId, ownerAccountId, repliesTo, ready }: Options<A>) {
  const t = useTranslations("desktopEdit");
  const { canEdit, edit } = useEditAttachment(account);
  const available = getEditBridge() !== null;
  const sessions = useEditSessions((s) => s.sessions);
  const instanceRef = useRef(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const heldRef = useRef(new Set<string>());
  const takenRef = useRef(new WeakSet<File>());
  const latest = useRef({ attachments, sessions });
  latest.current = { attachments, sessions };

  useEffect(() => {
    if (available) followEditSessions();
  }, [available]);

  // A file the user sent into a reply from an offer.
  const repliedRef = useRef(false);
  useEffect(() => {
    if (!available || !ready || repliedRef.current || !repliesTo) return;
    repliedRef.current = true;
    const files = takeFilesForReply(repliesTo);
    if (files.length > 0) void addFiles(files);
  }, [available, ready, repliesTo, addFiles]);

  // A file read back from a session: its chip takes the session on, and once it's up the
  // version it holds is no longer a change.
  useEffect(() => {
    if (!available) return;
    const untagged = attachments.some((att) => !att.editSessionId && editFileInfo(att.file));
    if (untagged) {
      setAttachments((list) => list.map((att) => {
        const info = att.editSessionId ? undefined : editFileInfo(att.file);
        return info ? { ...att, editSessionId: info.id } : att;
      }));
    }
    for (const att of attachments) {
      const info = editFileInfo(att.file);
      if (!info || !att.file || !att.blobId || att.uploading || att.error || takenRef.current.has(att.file)) continue;
      takenRef.current.add(att.file);
      void getEditBridge()?.taken(info.id, info.hash);
    }
  }, [available, attachments, setAttachments]);

  // A draft opened again finds its sessions by the draft's id and the file's name.
  useEffect(() => {
    if (!available || !draftId) return;
    const mine = sessions.filter((session) => {
      const source = parseEditSource(session.source);
      return source.kind === "draft" && source.draftId === draftId && !session.claimed;
    });
    if (mine.length === 0) return;
    setAttachments((list) => {
      let changed = false;
      const next = list.map((att) => {
        if (att.editSessionId) return att;
        const match = mine.find((session) => session.name === att.name && !list.some((other) => other.editSessionId === session.id));
        if (!match) return att;
        changed = true;
        return { ...att, editSessionId: match.id };
      });
      return changed ? next : list;
    });
  }, [available, draftId, sessions, setAttachments]);

  // Holds what's on a chip. One taken off a chip goes unless it has edits, which stay in the offers.
  const heldIds = attachments.flatMap((att) => (att.editSessionId ? [att.editSessionId] : []));
  const heldKey = [...new Set(heldIds)].sort().join("\n");
  useEffect(() => {
    const bridge = getEditBridge();
    if (!bridge) return;
    const now = new Set(heldKey ? heldKey.split("\n") : []);
    for (const id of now) {
      if (!heldRef.current.has(id)) bridge.claim(id, true);
    }
    for (const id of heldRef.current) {
      if (now.has(id)) continue;
      bridge.claim(id, false);
      const session = latest.current.sessions.find((s) => s.id === id);
      if (session?.changed) bridge.setSource(id, JSON.stringify({ kind: "file" } satisfies EditSource));
      else if (session) void bridge.discard(id);
    }
    heldRef.current = now;
  }, [heldKey]);

  // Follows the draft's id, which changes with every save.
  useEffect(() => {
    const bridge = getEditBridge();
    if (!bridge || !heldKey) return;
    const source = JSON.stringify({ kind: "draft", draftId, ownerAccountId } satisfies EditSource);
    for (const id of heldKey.split("\n")) bridge.setSource(id, source);
  }, [heldKey, draftId, ownerAccountId]);

  // Closing the composer isn't an end: the draft may be opened again.
  useEffect(() => () => {
    const bridge = getEditBridge();
    for (const id of heldRef.current) bridge?.claim(id, false);
    heldRef.current = new Set();
  }, []);

  const sessionOf = useCallback((att: A) => (att.editSessionId ? sessions.find((s) => s.id === att.editSessionId) : undefined), [sessions]);

  /** Whether this chip has saved edits to take. */
  const hasUpdate = useCallback((att: A) => sessionOf(att)?.changed === true, [sessionOf]);

  const startEdit = useCallback(async (att: A) => {
    const key = att.editSessionId
      ? `session:${att.editSessionId}`
      : att.blobId ? `blob:${account}:${att.blobId}` : `composer:${instanceRef.current}:${att.name}`;
    const result = await edit({
      key,
      name: att.name,
      type: att.type,
      account,
      source: { kind: "draft", draftId, ownerAccountId },
      load: () => load(att),
    });
    if (result.ok) {
      setAttachments((list) => list.map((item) => (
        (att.file ? item.file === att.file : item.blobId === att.blobId) ? { ...item, editSessionId: result.id } : item
      )));
    }
  }, [account, draftId, edit, load, ownerAccountId, setAttachments]);

  /** The edited file goes up first. Only then does the old one come off, so a failed upload loses nothing. */
  const update = useCallback(async (att: A) => {
    const id = att.editSessionId;
    if (!id) return;
    const outcome = await readEditedFile({ id, account });
    if (!outcome.ok) {
      toast.error(t(outcome.reason === "busy" ? "read_busy" : outcome.reason === "policy" ? "blocked_policy" : "read_failed", { name: att.name }));
      return;
    }
    const { file } = outcome;
    await addFiles([file]);
    setAttachments((list) => {
      const added = list.find((item) => item.file === file);
      if (added?.blobId && !added.error) return list.filter((item) => item.file === file || item.editSessionId !== id);
      return list.filter((item) => item.file !== file);
    });
  }, [account, addFiles, setAttachments, t]);

  /** Edits on the way out in an older version: asks first. False: don't send. */
  const confirmSend = useCallback(async (): Promise<boolean> => {
    const { attachments: list, sessions: all } = latest.current;
    const stale = list.flatMap((att) => {
      const session = att.editSessionId ? all.find((s) => s.id === att.editSessionId) : undefined;
      return session?.changed ? [session] : [];
    });
    const dialogs = getDesktopBridge()?.dialogs;
    if (stale.length === 0 || !dialogs) return true;
    const choice = await dialogs.confirm({
      type: "warning",
      message: t("send_stale_title", { name: stale[0].name }),
      detail: t("send_stale_detail"),
      buttons: [t("send_stale_send"), t("send_stale_back")],
      defaultId: 1,
    });
    return choice === 0;
  }, [t]);

  /** The draft was sent or discarded. Reads no state of the component: this can run after it has gone. */
  const finish = useCallback(() => {
    const bridge = getEditBridge();
    if (!bridge) return;
    const { attachments: list, sessions: all } = latest.current;
    const ids = new Set(list.flatMap((att) => (att.editSessionId ? [att.editSessionId] : [])));
    for (const id of ids) {
      heldRef.current.delete(id);
      bridge.claim(id, false);
      if (all.find((s) => s.id === id)?.changed) bridge.setSource(id, JSON.stringify({ kind: "file" } satisfies EditSource));
      else void bridge.discard(id);
    }
  }, []);

  return { canEdit, startEdit, hasUpdate, update, confirmSend, finish };
}
