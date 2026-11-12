"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { create } from "zustand";
import { Dialog } from "@/components/ui/dialog";
import type { Email, Mailbox } from "@/lib/jmap/types";
import { resolveMoveOwnerAccountId } from "@/lib/move-targets";
import { useMoveFolders, useMoveUnavailableHint } from "@/hooks/use-move-folders";
import { toast } from "@/stores/toast-store";
import { MoveFolderList, useMoveMenu } from "./move-target-list";

interface MoveDialogRequest {
  /** The messages to move. */
  emails: Email[];
  onMove: (mailboxId: string) => void;
  /**
   * The folders the asking Move menu listed, and the folder it was in, where
   * they aren't the host's: a Pro folder tab's reader files within its own
   * account, whatever Mail shows.
   */
  mailboxes?: Mailbox[];
  selectedMailbox?: string;
}

interface MoveDialogState {
  request: MoveDialogRequest | null;
  /** Mounted hosts: without one, nothing offers the dialog. */
  hosts: number;
  open: (request: MoveDialogRequest) => void;
  close: () => void;
}

export const useMoveDialogStore = create<MoveDialogState>((set) => ({
  request: null,
  hosts: 0,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/**
 * "Choose folder…" at the end of a long Move list: the dialog with the filter
 * field. Undefined where no dialog host is mounted.
 */
export function useChooseMoveFolder(): ((request: MoveDialogRequest) => void) | undefined {
  const hosts = useMoveDialogStore((s) => s.hosts);
  const open = useMoveDialogStore((s) => s.open);
  return hosts > 0 ? open : undefined;
}

interface MoveToDialogProps {
  /** The messages to move; the dialog is open while there are some. */
  emails: Email[];
  mailboxes: Mailbox[];
  selectedMailbox: string;
  onClose: () => void;
  onMove: (mailboxId: string) => void;
}

/**
 * Move to…: the same folders as the Move menus (lib/move-menu.ts), in a
 * dialog with a filter field. From the command palette, the Message menu and
 * "Choose folder…" in a long Move menu.
 */
export function MoveToDialog({ emails, mailboxes, selectedMailbox, onClose, onMove }: MoveToDialogProps) {
  const t = useTranslations("context_menu");
  const model = useMoveMenu(mailboxes, {
    currentMailboxId: selectedMailbox,
    ownerAccountId: resolveMoveOwnerAccountId(emails[0], mailboxes, selectedMailbox),
    emails,
  });
  return (
    <Dialog isOpen={emails.length > 0} onClose={onClose} title={t("move_to_dialog")} bodyClassName="px-2" size="sm">
      <div role="menu" aria-label={t("move_to_dialog")} className="max-h-[60vh] overflow-y-auto" data-testid="move-dialog">
        <MoveFolderList
          variant="dialog"
          alwaysFilter
          model={model}
          onPick={(mailboxId) => {
            onClose();
            onMove(mailboxId);
          }}
        />
      </div>
    </Dialog>
  );
}

/**
 * Shows the dialog a Move menu asked for. Mounted once, where the mail is.
 * Without folders of its own, the request gets the folders of the login its
 * messages are in (moveFoldersFor); where there are none to offer (several
 * logins, or that login's list can't be had) it says why instead.
 */
export function MoveToDialogHost({ selectedMailbox }: { selectedMailbox: string }) {
  const request = useMoveDialogStore((s) => s.request);
  const close = useMoveDialogStore((s) => s.close);
  const tNotifications = useTranslations("notifications");
  const hint = useMoveUnavailableHint();
  const offered = useMoveFolders(request?.emails ?? NO_EMAILS);
  const refused = !!request && !request.mailboxes && !!offered.unavailable;
  useEffect(() => {
    useMoveDialogStore.setState((s) => ({ hosts: s.hosts + 1 }));
    return () => useMoveDialogStore.setState((s) => ({ hosts: s.hosts - 1, request: s.hosts <= 1 ? null : s.request }));
  }, []);
  const reason = offered.unavailable;
  useEffect(() => {
    if (!refused) return;
    toast.error(tNotifications("move_failed"), hint(reason));
    close();
    // Once per refused request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refused]);
  if (!request || refused) return null;
  return (
    <MoveToDialog
      emails={request.emails}
      mailboxes={request.mailboxes ?? offered.mailboxes}
      selectedMailbox={request.mailboxes ? request.selectedMailbox ?? "" : selectedMailbox}
      onClose={close}
      onMove={request.onMove}
    />
  );
}

const NO_EMAILS: Email[] = [];
