"use client";

import { useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslations } from "next-intl";
import { Code, MoreVertical, Printer } from "@/components/icons";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useDevicePolicy } from "@/hooks/use-device-policy";
import { useEmailExport } from "@/hooks/use-message-file-actions";
import type { Email } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { resolveEmailBlobContext, useEmailStore, type EmailBlobContext } from "@/stores/email-store";
import { ViewSourceDialog } from "./view-source-dialog";
import { cn } from "@/lib/utils";

interface ConversationMessageMenuProps {
  email: Email;
  /** The route captured for this message when the conversation was opened. */
  blobSource?: EmailBlobContext;
  /** Prints this message alone. Left out: no Print (the organisation turned printing off). */
  onPrint?: () => void;
  /** The look of the ⋮ button, to match the buttons next to it. */
  className?: string;
  iconClassName?: string;
  /** More items for the same menu, such as plugins' reader actions, so a message has one ⋮. */
  children?: ReactNode;
  /** Whether `children` has anything to show; the ⋮ shows for built-in or extra actions. */
  hasExtra?: boolean;
}

/**
 * One conversation message's own ⋮: what applies to that message rather
 * than the whole conversation.
 */
export function ConversationMessageMenu({ email, blobSource, onPrint, className, iconClassName, children, hasExtra }: ConversationMessageMenuProps) {
  const t = useTranslations("email_viewer");
  const menu = useContextMenu<null>();
  const { client } = useAuthStore(useShallow((state) => ({
    client: state.client, revision: state.connectedAccountsRevision,
  })));
  const source = useEmailStore(useShallow(() => blobSource ?? resolveEmailBlobContext(email, client)));
  const devices = useDevicePolicy(source.clientAccountId ?? email);
  const exportEmail = useEmailExport();
  const [sourceTarget, setSourceTarget] = useState<{ emailId: string; blobId: string; route: EmailBlobContext } | null>(null);
  const canViewSource = !!email.blobId && !devices.noExport;
  const sourceOpen = canViewSource && sourceTarget?.emailId === email.id
    && sourceTarget.blobId === email.blobId && sourceTarget.route === source;
  if (!onPrint && !canViewSource && !hasExtra) return null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); menu.openContextMenuFrom(e.currentTarget, null, "end"); }}
        title={t("more_actions")}
        aria-label={t("more_actions")}
        aria-haspopup="menu"
        aria-expanded={menu.contextMenu.isOpen}
        data-conversation-message-menu=""
        className={cn(
          "grid place-items-center w-10 h-10 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors",
          className,
        )}
      >
        <MoreVertical className={cn("w-5 h-5", iconClassName)} />
      </button>
      <ContextMenu ref={menu.menuRef} isOpen={menu.contextMenu.isOpen} position={menu.contextMenu.position} onClose={menu.closeContextMenu}>
        {onPrint && (
          <ContextMenuItem
            icon={Printer}
            label={t("print")}
            testId="conversation-message-print"
            onClick={() => { menu.closeContextMenu(); onPrint(); }}
          />
        )}
        {canViewSource && (
          <ContextMenuItem
            icon={Code}
            label={t("view_source")}
            onClick={() => {
              menu.closeContextMenu();
              if (email.blobId) setSourceTarget({ emailId: email.id, blobId: email.blobId, route: source });
            }}
          />
        )}
        {hasExtra && <div onClickCapture={() => menu.closeContextMenu()}>{children}</div>}
      </ContextMenu>
      {sourceOpen && (
        <ViewSourceDialog
          isOpen
          onClose={() => setSourceTarget(null)}
          blobId={sourceTarget.blobId}
          client={source.client}
          accountId={source.accountId}
          onDownload={() => void exportEmail(email, undefined, source)}
        />
      )}
    </>
  );
}
