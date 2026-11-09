"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { create } from "zustand";
import { Dialog } from "@/components/ui/dialog";
import type { Email, Mailbox } from "@/lib/jmap/types";
import { resolveMoveOwnerAccountId } from "@/lib/move-targets";
import { MoveFolderList, useMoveMenu } from "./move-target-list";

interface MoveDialogRequest {
  /** The messages to move. */
  emails: Email[];
  onMove: (mailboxId: string) => void;
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

/** Shows the dialog a Move menu asked for. Mounted once, where the mail is. */
export function MoveToDialogHost({ mailboxes, selectedMailbox }: { mailboxes: Mailbox[]; selectedMailbox: string }) {
  const request = useMoveDialogStore((s) => s.request);
  const close = useMoveDialogStore((s) => s.close);
  useEffect(() => {
    useMoveDialogStore.setState((s) => ({ hosts: s.hosts + 1 }));
    return () => useMoveDialogStore.setState((s) => ({ hosts: s.hosts - 1, request: s.hosts <= 1 ? null : s.request }));
  }, []);
  if (!request) return null;
  return (
    <MoveToDialog
      emails={request.emails}
      mailboxes={mailboxes}
      selectedMailbox={selectedMailbox}
      onClose={close}
      onMove={request.onMove}
    />
  );
}
